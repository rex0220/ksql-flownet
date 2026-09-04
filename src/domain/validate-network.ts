import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type AnySchema, type ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import { stableTopologicalSort } from "../dag/topological-sort.js";
import { validateScheduledPeriodPolicy } from "./business-key.js";
import type {
  NetworkDefinition,
  ValidationError,
  ValidationResult,
} from "./network-definition.js";

const schemaPath = fileURLToPath(
  new URL("../../schemas/network-definition.schema.json", import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function schemaError(error: ErrorObject): ValidationError {
  const path = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    return {
      code: "UNKNOWN_PROPERTY",
      path,
      message: `unknown property '${property}'`,
    };
  }
  return {
    code: "SCHEMA_INVALID",
    path,
    message: error.message ?? "is invalid",
  };
}

function semanticErrors(definition: NetworkDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodeIds = new Set<string>();

  if (definition.business_key_policy.type === "scheduled_period") {
    errors.push(
      ...validateScheduledPeriodPolicy(definition.business_key_policy),
    );
  }

  const { lease_duration_sec: lease, heartbeat_interval_sec: heartbeat } =
    definition.network_lock;
  if (heartbeat >= lease) {
    errors.push({
      code: "NETWORK_LOCK_HEARTBEAT_NOT_LESS_THAN_LEASE",
      path: "$.network_lock.heartbeat_interval_sec",
      message: "must be less than lease_duration_sec",
    });
  }
  if (heartbeat > lease / 3) {
    errors.push({
      code: "NETWORK_LOCK_HEARTBEAT_EXCEEDS_ONE_THIRD",
      path: "$.network_lock.heartbeat_interval_sec",
      message: "must be at most lease_duration_sec / 3",
    });
  }

  definition.nodes.forEach((node, nodeIndex) => {
    const nodePath = `$.nodes/${nodeIndex}`;
    if (nodeIds.has(node.id)) {
      errors.push({
        code: "DUPLICATE_NODE_ID",
        path: `${nodePath}/id`,
        message: `duplicate node id '${node.id}'`,
      });
    }
    nodeIds.add(node.id);

    for (const [sourceName, pattern] of Object.entries(node.inputs ?? {})) {
      const problem = inputPatternProblem(pattern);
      if (problem !== null) {
        errors.push({
          code: "INPUT_PATTERN_INVALID",
          path: `${nodePath}/inputs/${escapeJsonPointer(sourceName)}`,
          message: problem,
        });
      }
    }

    if (node.trigger_rule !== "all_success") {
      errors.push({
        code: "TRIGGER_RULE_UNSUPPORTED",
        path: `${nodePath}/trigger_rule`,
        message: `'${node.trigger_rule}' is reserved and not supported in Phase 1`,
      });
    }

    const dependencies = new Set<string>();
    node.depends_on.forEach((dependency, dependencyIndex) => {
      const dependencyPath = `${nodePath}/depends_on/${dependencyIndex}`;
      if (dependency === node.id) {
        errors.push({
          code: "SELF_DEPENDENCY",
          path: dependencyPath,
          message: "self-dependency is not allowed",
        });
      }
      if (dependencies.has(dependency)) {
        errors.push({
          code: "DUPLICATE_DEPENDENCY",
          path: dependencyPath,
          message: `duplicate dependency '${dependency}'`,
        });
      }
      dependencies.add(dependency);
    });
  });

  definition.nodes.forEach((node, nodeIndex) => {
    node.depends_on.forEach((dependency, dependencyIndex) => {
      if (!nodeIds.has(dependency)) {
        errors.push({
          code: "UNKNOWN_DEPENDENCY",
          path: `$.nodes/${nodeIndex}/depends_on/${dependencyIndex}`,
          message: `unknown dependency '${dependency}'`,
        });
      }
    });
  });

  if (errors.some((error) => error.code === "DUPLICATE_NODE_ID")) {
    return errors;
  }
  if (errors.some((error) => error.code === "UNKNOWN_DEPENDENCY")) {
    return errors;
  }

  const sorted = stableTopologicalSort(definition.nodes);
  if (sorted.cyclicNodeIds.length > 0) {
    errors.push({
      code: "CYCLE_DETECTED",
      path: "$.nodes",
      message: `cycle detected; nodes not sortable: ${sorted.cyclicNodeIds.join(", ")}`,
    });
  }
  return errors;
}

const INPUT_PLACEHOLDERS = new Set(["business_key", "profile"]);

function inputPatternProblem(pattern: string): string | null {
  if (pattern.length === 0) return "input pattern must not be empty";
  if (pattern.includes("\0")) return "input pattern must not contain NUL";
  if (
    pattern.startsWith("/") ||
    pattern.startsWith("\\") ||
    /^[A-Za-z]:/u.test(pattern)
  )
    return "input pattern must be a relative path without a drive or UNC prefix";

  const literal = pattern.replace(/\{([^{}]*)\}/gu, (_match, name: string) => {
    return INPUT_PLACEHOLDERS.has(name) ? "placeholder" : `{${name}}`;
  });
  if (literal.includes("{") || literal.includes("}")) {
    return "input pattern contains an unknown or malformed placeholder";
  }
  if (pattern.includes("{run_id}")) {
    return "input pattern placeholder '{run_id}' is not allowed";
  }
  if (
    pattern
      .split(/[\\/]/u)
      .some((segment) => segment === "." || segment === "..")
  ) {
    return "input pattern must not contain '.' or '..' path segments";
  }
  return null;
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

export function validateNetworkDefinition(input: unknown): ValidationResult {
  if (!validateSchema(input)) {
    return { errors: (validateSchema.errors ?? []).map(schemaError) };
  }

  const raw = input as Omit<NetworkDefinition, "max_active_runs"> & {
    readonly max_active_runs?: number;
  };
  const definition: NetworkDefinition = {
    ...raw,
    max_active_runs: raw.max_active_runs ?? 1,
  };
  const errors = semanticErrors(definition);
  return { definition, errors };
}
