import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type AnySchema, type ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import { stableTopologicalSort } from "../dag/topological-sort.js";
import type {
  NetworkDefinition,
  ScheduledPeriodPolicy,
  ValidationError,
  ValidationResult,
} from "./network-definition.js";

const schemaPath = fileURLToPath(
  new URL("../../schemas/network-definition.schema.json", import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
const ALLOWED_PLACEHOLDERS = new Set([
  "{network_id}",
  "{yyyy}",
  "{MM}",
  "{dd}",
]);

function schemaError(error: ErrorObject): ValidationError {
  const path = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    return { path, message: `unknown property '${property}'` };
  }
  return { path, message: error.message ?? "is invalid" };
}

function validateTimezone(
  policy: ScheduledPeriodPolicy,
  errors: ValidationError[],
): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: policy.timezone }).format();
  } catch {
    errors.push({
      path: "$.business_key_policy.timezone",
      message: `unknown IANA timezone '${policy.timezone}'`,
    });
  }
}

function validateFormat(
  policy: ScheduledPeriodPolicy,
  errors: ValidationError[],
): void {
  const placeholders = policy.format.match(/\{[^{}]*\}/g) ?? [];
  for (const placeholder of placeholders) {
    if (!ALLOWED_PLACEHOLDERS.has(placeholder)) {
      errors.push({
        path: "$.business_key_policy.format",
        message: `unsupported placeholder '${placeholder}'`,
      });
    }
  }
  const remainder = placeholders.reduce(
    (value, placeholder) => value.replace(placeholder, ""),
    policy.format,
  );
  if (remainder.includes("{") || remainder.includes("}")) {
    errors.push({
      path: "$.business_key_policy.format",
      message: "contains an invalid placeholder expression",
    });
  }
}

function semanticErrors(definition: NetworkDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodeIds = new Set<string>();

  if (definition.business_key_policy.type === "scheduled_period") {
    validateTimezone(definition.business_key_policy, errors);
    validateFormat(definition.business_key_policy, errors);
  }

  const { lease_duration_sec: lease, heartbeat_interval_sec: heartbeat } =
    definition.network_lock;
  if (heartbeat >= lease) {
    errors.push({
      path: "$.network_lock.heartbeat_interval_sec",
      message: "must be less than lease_duration_sec",
    });
  }
  if (heartbeat > lease / 3) {
    errors.push({
      path: "$.network_lock.heartbeat_interval_sec",
      message: "must be at most lease_duration_sec / 3",
    });
  }

  definition.nodes.forEach((node, nodeIndex) => {
    const nodePath = `$.nodes/${nodeIndex}`;
    if (nodeIds.has(node.id)) {
      errors.push({
        path: `${nodePath}/id`,
        message: `duplicate node id '${node.id}'`,
      });
    }
    nodeIds.add(node.id);

    if (node.trigger_rule !== "all_success") {
      errors.push({
        path: `${nodePath}/trigger_rule`,
        message: `'${node.trigger_rule}' is reserved and not supported in Phase 1`,
      });
    }

    const dependencies = new Set<string>();
    node.depends_on.forEach((dependency, dependencyIndex) => {
      const dependencyPath = `${nodePath}/depends_on/${dependencyIndex}`;
      if (dependency === node.id) {
        errors.push({
          path: dependencyPath,
          message: "self-dependency is not allowed",
        });
      }
      if (dependencies.has(dependency)) {
        errors.push({
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
          path: `$.nodes/${nodeIndex}/depends_on/${dependencyIndex}`,
          message: `unknown dependency '${dependency}'`,
        });
      }
    });
  });

  if (errors.some((error) => error.message.includes("duplicate node id"))) {
    return errors;
  }
  if (errors.some((error) => error.message.includes("unknown dependency"))) {
    return errors;
  }

  const sorted = stableTopologicalSort(definition.nodes);
  if (sorted.cyclicNodeIds.length > 0) {
    errors.push({
      path: "$.nodes",
      message: `cycle detected; nodes not sortable: ${sorted.cyclicNodeIds.join(", ")}`,
    });
  }
  return errors;
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
