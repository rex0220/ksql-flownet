import { readFileSync } from "node:fs";

import {
  resolveNode,
  type ResolveNodeInput,
} from "../orchestration/resolve-node.js";
import { KintonePersistenceRepository } from "../persistence/kintone/repository.js";
import type { PersistenceRepository } from "../persistence/repository.js";

interface Arguments {
  runId?: string;
  nodeId?: string;
  outcome?: ResolveNodeInput["outcome"];
  reasonFile?: string;
  evidenceRef?: string;
  stopConfirmedBy?: string;
  stopEvidenceRef?: string;
  approvedBy?: string;
  manualCompletion: boolean;
  compensation: boolean;
  errors: string[];
}

export interface ResolveNodeCommandDependencies {
  repository: PersistenceRepository;
  servicePrincipal: string;
  requestedBy: string;
  readFile?: (path: string) => string;
  now?: () => Date;
}

export async function runResolveNodeCommand(
  args: readonly string[],
  dependencies?: ResolveNodeCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.errors.length > 0) {
    process.stderr.write(
      `Invalid resolve-node arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const runtime = dependencies ?? productionDependencies();
    const reason = (runtime.readFile ?? ((path) => readFileSync(path, "utf8")))(
      parsed.reasonFile!,
    );
    const result = await resolveNode({
      repository: runtime.repository,
      runId: parsed.runId!,
      nodeId: parsed.nodeId!,
      outcome: parsed.outcome!,
      resolutionType: parsed.manualCompletion
        ? "NODE_MANUAL_COMPLETION_CONFIRMED"
        : parsed.compensation
          ? "NODE_COMPENSATION_COMPLETED"
          : "OUTCOME_CONFIRMED",
      reason,
      evidenceRef: parsed.evidenceRef!,
      servicePrincipal: runtime.servicePrincipal,
      requestedBy: runtime.requestedBy,
      approvedBy: parsed.approvedBy ?? "",
      stopConfirmedBy: parsed.stopConfirmedBy!,
      stopEvidenceRef: parsed.stopEvidenceRef!,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
    });
    process.stdout.write(
      `RESOLVED: ${parsed.runId}/${parsed.nodeId} -> ${result.nodeState.value.status} (revision ${result.nodeState.revision}).\n`,
    );
    return 0;
  } catch (error) {
    const code = errorCode(error, "RESOLVE_NODE_FAILED");
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    return 1;
  }
}

function parseArguments(args: readonly string[]): Arguments {
  const result: Arguments = {
    manualCompletion: false,
    compensation: false,
    errors: [],
  };
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--manual-completion" || argument === "--compensation") {
      const key = argument.slice(2) as "manual-completion" | "compensation";
      if (key === "manual-completion") {
        if (result.manualCompletion)
          result.errors.push(`${argument} was specified more than once`);
        result.manualCompletion = true;
      } else {
        if (result.compensation)
          result.errors.push(`${argument} was specified more than once`);
        result.compensation = true;
      }
      continue;
    }
    if (!argument.startsWith("--")) {
      result.errors.push(`unexpected argument '${argument}'`);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      result.errors.push(`${argument} requires a value`);
      continue;
    }
    if (values.has(argument))
      result.errors.push(`${argument} was specified more than once`);
    values.set(argument, value);
    index += 1;
  }
  const allowed = new Set([
    "--run-id",
    "--node-id",
    "--to",
    "--reason-file",
    "--evidence-ref",
    "--stop-confirmed-by",
    "--stop-evidence-ref",
    "--approved-by",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) result.errors.push(`unknown option '${key}'`);
  }
  for (const key of [
    "--run-id",
    "--node-id",
    "--to",
    "--reason-file",
    "--evidence-ref",
    "--stop-confirmed-by",
    "--stop-evidence-ref",
  ]) {
    if (!values.has(key)) result.errors.push(`${key} is required`);
  }
  const outcome = values.get("--to");
  if (
    outcome !== undefined &&
    outcome !== "SUCCESS" &&
    outcome !== "FAILED" &&
    outcome !== "CANCELLED"
  ) {
    result.errors.push("--to must be SUCCESS, FAILED, or CANCELLED");
  }
  if (result.manualCompletion && result.compensation)
    result.errors.push(
      "--manual-completion and --compensation are mutually exclusive",
    );
  return {
    ...result,
    ...(values.has("--run-id") ? { runId: values.get("--run-id")! } : {}),
    ...(values.has("--node-id") ? { nodeId: values.get("--node-id")! } : {}),
    ...(outcome === "SUCCESS" || outcome === "FAILED" || outcome === "CANCELLED"
      ? { outcome }
      : {}),
    ...(values.has("--reason-file")
      ? { reasonFile: values.get("--reason-file")! }
      : {}),
    ...(values.has("--evidence-ref")
      ? { evidenceRef: values.get("--evidence-ref")! }
      : {}),
    ...(values.has("--stop-confirmed-by")
      ? { stopConfirmedBy: values.get("--stop-confirmed-by")! }
      : {}),
    ...(values.has("--stop-evidence-ref")
      ? { stopEvidenceRef: values.get("--stop-evidence-ref")! }
      : {}),
    ...(values.has("--approved-by")
      ? { approvedBy: values.get("--approved-by")! }
      : {}),
  };
}

function productionDependencies(): ResolveNodeCommandDependencies {
  return {
    repository: repositoryFromEnvironment(),
    servicePrincipal: requiredEnvironment("KSQL_FLOWNET_SERVICE_PRINCIPAL"),
    requestedBy: requiredEnvironment("KSQL_FLOWNET_REQUESTED_BY"),
  };
}

export function repositoryFromEnvironment(): KintonePersistenceRepository {
  return new KintonePersistenceRepository({
    baseUrl: requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(/\/$/u, ""),
    stateAppId: positiveIntegerEnvironment("KSQL_FLOWNET_STATE_APP_ID"),
    stateApiToken: requiredEnvironment("KSQL_FLOWNET_STATE_API_TOKEN"),
    auditAppId: positiveIntegerEnvironment("KSQL_FLOWNET_AUDIT_APP_ID"),
    auditApiToken: requiredEnvironment("KSQL_FLOWNET_AUDIT_API_TOKEN"),
  });
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : fallback;
}
