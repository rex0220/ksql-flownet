import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { loadNetworkDefinition } from "../domain/load-network.js";
import {
  archiveRun,
  type ArchiveRunOutcome,
} from "../orchestration/archive-run.js";
import {
  LeaseMonitor,
  NetworkLockManager,
} from "../persistence/network-lock.js";
import {
  repositoryFromEnvironment,
  requiredEnvironment,
} from "./resolve-node-command.js";

interface Parsed {
  networkPath?: string;
  runId?: string;
  reasonFile?: string;
  profile?: string;
  errors: string[];
}
export interface ArchiveRunCommandDependencies {
  readonly execute: (input: {
    networkPath: string;
    runId: string;
    reason: string;
    profile?: string;
  }) => Promise<ArchiveRunOutcome>;
  readonly readFile?: (path: string) => string;
}

export async function runArchiveRunCommand(
  args: readonly string[],
  dependencies?: ArchiveRunCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.errors.length > 0) {
    process.stderr.write(
      `Invalid archive-run arguments:\n${parsed.errors.map((x) => `- ${x}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const reason = (
      dependencies?.readFile ?? ((path) => readFileSync(path, "utf8"))
    )(parsed.reasonFile!);
    const outcome =
      dependencies === undefined
        ? await productionArchive(
            parsed.networkPath!,
            parsed.runId!,
            reason,
            parsed.profile,
          )
        : await dependencies.execute({
            networkPath: parsed.networkPath!,
            runId: parsed.runId!,
            reason,
            ...(parsed.profile === undefined
              ? {}
              : { profile: parsed.profile }),
          });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    const success =
      outcome.outcome === "ARCHIVED" &&
      outcome.audit === "RECORDED" &&
      outcome.lock_released;
    if (success)
      process.stderr.write(
        `ARCHIVED: ${outcome.run_id} (revision ${outcome.run_revision})\n`,
      );
    else
      process.stderr.write(
        `Error [${outcomeCode(outcome)}]: archive-run did not complete cleanly\n`,
      );
    return success ? 0 : 1;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "ARCHIVE_RUN_FAILED";
    process.stderr.write(
      `Error [${code}]: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function productionArchive(
  networkPath: string,
  runId: string,
  reason: string,
  profileOption?: string,
): Promise<ArchiveRunOutcome> {
  const loaded = loadNetworkDefinition(networkPath);
  if (loaded.definition === undefined || loaded.errors.length > 0)
    throw new Error("network definition is invalid");
  const profile = profileOption ?? requiredEnvironment("KSQL_FLOWNET_PROFILE");
  const baseUrl = requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(
    /\/$/u,
    "",
  );
  const appId = Number(requiredEnvironment("KSQL_FLOWNET_STATE_APP_ID"));
  const token = requiredEnvironment("KSQL_FLOWNET_STATE_API_TOKEN");
  const leaseDuration = loaded.definition.network_lock.lease_duration_sec;
  return archiveRun({
    repository: repositoryFromEnvironment(),
    runId,
    requestedBy: requiredEnvironment("KSQL_FLOWNET_REQUESTED_BY"),
    reason,
    // ポーラー経由(cron 環境)では未設定のことがあるため、ホスト識別へフォールバックする。
    servicePrincipal:
      process.env.KSQL_FLOWNET_SERVICE_PRINCIPAL?.trim() ||
      process.env.KSQL_FLOWNET_HOST?.trim() ||
      hostname(),
    lockManagerFactory: (owner) =>
      new NetworkLockManager({
        baseUrl,
        appId,
        apiToken: token,
        profile,
        networkId: loaded.definition!.network_id,
        ownerInvocationId: owner,
        ownerInstanceId: process.env.KSQL_FLOWNET_HOST ?? hostname(),
        leaseDurationSec: leaseDuration,
      }),
    leaseMonitorFactory: (manager, reference) =>
      new LeaseMonitor(manager as NetworkLockManager, reference, {
        leaseDurationSec: leaseDuration,
        heartbeatIntervalSec:
          loaded.definition!.network_lock.heartbeat_interval_sec,
      }),
  });
}

function outcomeCode(value: ArchiveRunOutcome): string {
  if ("code" in value) return value.code;
  if (value.outcome === "ALREADY_ARCHIVED") return "ALREADY_ARCHIVED";
  return value.lock_released
    ? "ARCHIVE_RUN_FAILED"
    : "RUN_ARCHIVED_LOCK_UNRELEASED";
}

function parseArguments(args: readonly string[]): Parsed {
  const result: Parsed = { errors: [] };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (result.networkPath !== undefined)
        result.errors.push("exactly one <network.yaml> path is required");
      else result.networkPath = arg;
      continue;
    }
    if (!["--run-id", "--reason-file", "--profile"].includes(arg)) {
      result.errors.push(`unknown option '${arg}'`);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      result.errors.push(`${arg} requires a value`);
      continue;
    }
    if (seen.has(arg))
      result.errors.push(`${arg} was specified more than once`);
    seen.add(arg);
    index += 1;
    if (arg === "--run-id") result.runId = value;
    else if (arg === "--reason-file") result.reasonFile = value;
    else result.profile = value;
  }
  if (result.networkPath === undefined)
    result.errors.push("<network.yaml> is required");
  if (result.runId === undefined) result.errors.push("--run-id is required");
  if (result.reasonFile === undefined)
    result.errors.push("--reason-file is required");
  return result;
}
