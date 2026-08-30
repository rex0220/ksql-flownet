import { readFileSync } from "node:fs";

import { recordJobUnlock } from "../orchestration/job-lock-audit.js";
import type { PersistenceRepository } from "../persistence/repository.js";
import {
  repositoryFromEnvironment,
  requiredEnvironment,
} from "./resolve-node-command.js";

export interface RecordJobUnlockCommandDependencies {
  repository: PersistenceRepository;
  servicePrincipal: string;
  requestedBy: string;
  readFile?: (path: string) => string;
  now?: () => Date;
  uuid?: () => string;
}

export async function runRecordJobUnlockCommand(
  args: readonly string[],
  dependencies?: RecordJobUnlockCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.errors.length > 0) {
    process.stderr.write(
      `Invalid record-job-unlock arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const runtime = dependencies ?? {
      repository: repositoryFromEnvironment(),
      servicePrincipal: requiredEnvironment("KSQL_FLOWNET_SERVICE_PRINCIPAL"),
      requestedBy: requiredEnvironment("KSQL_FLOWNET_REQUESTED_BY"),
    };
    const read =
      runtime.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const rawResult = read(parsed.values.get("--result-file")!);
    const audit = await recordJobUnlock({
      repository: runtime.repository,
      runId: parsed.values.get("--run-id")!,
      nodeId: parsed.values.get("--node-id")!,
      result: JSON.parse(rawResult) as unknown,
      reason: read(parsed.values.get("--reason-file")!),
      evidenceRef: parsed.values.get("--evidence-ref")!,
      servicePrincipal: runtime.servicePrincipal,
      requestedBy: runtime.requestedBy,
      stopConfirmedBy: parsed.values.get("--stop-confirmed-by")!,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
      ...(runtime.uuid === undefined ? {} : { uuid: runtime.uuid }),
    });
    process.stdout.write(
      `RECORDED: ${audit.lock_recovery_result.outcome} for ${audit.lock_recovery_result.jobKey} (${audit.event_id}).\n`,
    );
    return 0;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "RECORD_JOB_UNLOCK_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    return 1;
  }
}

function parseArguments(args: readonly string[]): {
  values: Map<string, string>;
  errors: string[];
} {
  const values = new Map<string, string>();
  const errors: string[] = [];
  const allowed = new Set([
    "--result-file",
    "--run-id",
    "--node-id",
    "--reason-file",
    "--evidence-ref",
    "--stop-confirmed-by",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (!key.startsWith("--")) {
      errors.push(`unexpected argument '${key}'`);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${key} requires a value`);
      continue;
    }
    if (!allowed.has(key)) errors.push(`unknown option '${key}'`);
    if (values.has(key)) errors.push(`${key} was specified more than once`);
    values.set(key, value);
    index += 1;
  }
  for (const key of allowed) {
    if (!values.has(key)) errors.push(`${key} is required`);
  }
  return { values, errors };
}
