import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { downloadBundle, readStoreZip, uploadBundle } from "../bundle/index.js";
import {
  loadNetworkDefinition,
  loadNetworkDefinitionSource,
} from "../domain/load-network.js";
import { AttemptExecutor } from "../executor/attempt-executor.js";
import { KintoneJobLogReader } from "../executor/job-log-reader.js";
import { KsqlFlowCli } from "../executor/ksql-flow-cli.js";
import { RunSubprocess } from "../executor/run-subprocess.js";
import {
  ensureRun,
  EnsureRunError,
  type EnsureRunInput,
} from "../orchestration/ensure-run.js";
import {
  runSequentialScheduler,
  type SequentialSchedulerSummary,
} from "../orchestration/sequential-scheduler.js";
import { KintonePersistenceRepository } from "../persistence/kintone/repository.js";
import {
  LeaseMonitor,
  NetworkLockManager,
} from "../persistence/network-lock.js";

interface RunNetworkArguments {
  readonly networkPath?: string;
  readonly scheduledFor?: string;
  readonly businessKey?: string;
  readonly resume: boolean;
  readonly resumeRunId?: string;
  readonly rerunFrom?: string;
  readonly ksqlFlowBin?: string;
  readonly ksqlFlowConfig?: string;
  readonly ksqlFlowWorkdir?: string;
  readonly errors: readonly string[];
}

export type EnsureRunInvoker = (
  input: Omit<
    EnsureRunInput,
    "repository" | "lockManager" | "executor" | "bundleStore"
  >,
) => ReturnType<typeof ensureRun>;

export interface RunNetworkCommandDependencies {
  readonly invoke: EnsureRunInvoker;
  readonly schedule: (
    result: Awaited<ReturnType<EnsureRunInvoker>>,
  ) => Promise<SequentialSchedulerSummary>;
  readonly profile: string;
  readonly requestedBy: string;
  readonly host: string;
}

export async function runRunNetworkCommand(
  args: readonly string[],
  dependencies?: RunNetworkCommandDependencies,
): Promise<number> {
  const parsed = parseRunNetworkArguments(args);
  if (parsed.errors.length > 0 || parsed.networkPath === undefined) {
    process.stderr.write(
      `Invalid run-network arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const runtime = dependencies ?? productionDependencies(parsed);
    const result = await runtime.invoke({
      networkPath: parsed.networkPath,
      profile: runtime.profile,
      requestedBy: runtime.requestedBy,
      host: runtime.host,
      resume: parsed.resume,
      ...(parsed.scheduledFor === undefined
        ? {}
        : { scheduledFor: parsed.scheduledFor }),
      ...(parsed.businessKey === undefined
        ? {}
        : { businessKey: parsed.businessKey }),
      ...(parsed.resumeRunId === undefined
        ? {}
        : { resumeRunId: parsed.resumeRunId }),
      ...(parsed.rerunFrom === undefined
        ? {}
        : { rerunFrom: parsed.rerunFrom }),
    });
    if (result.outcome === "NOOP") {
      process.stdout.write(
        `NO-OP: Run ${result.run.value.run_id} is already SUCCESS; nothing was executed.\n`,
      );
      return 0;
    }
    const summary = await runtime.schedule(result);
    process.stdout.write(
      `${result.outcome}: Run ${result.run.value.run_id} finished with aggregate ${summary.aggregateStatus} (${summary.invocationResultCode}).\n`,
    );
    return summary.aggregateStatus === "SUCCESS" ? 0 : 1;
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    if (error instanceof EnsureRunError && error.blockedBy.length > 0) {
      process.stderr.write(
        `Blocking run_id(s): ${error.blockedBy.join(", ")}\n`,
      );
    }
    return 1;
  }
}

function parseRunNetworkArguments(
  args: readonly string[],
): RunNetworkArguments {
  let networkPath: string | undefined;
  let scheduledFor: string | undefined;
  let businessKey: string | undefined;
  let resumeRunId: string | undefined;
  let rerunFrom: string | undefined;
  let ksqlFlowBin: string | undefined;
  let ksqlFlowConfig: string | undefined;
  let ksqlFlowWorkdir: string | undefined;
  let resume = false;
  const errors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--resume") {
      if (resume) errors.push("--resume was specified more than once");
      resume = true;
      continue;
    }
    if (
      argument === "--scheduled-for" ||
      argument === "--business-key" ||
      argument === "--resume-run" ||
      argument === "--rerun-from" ||
      argument === "--ksql-flow-bin" ||
      argument === "--ksql-flow-config" ||
      argument === "--ksql-flow-workdir"
    ) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        errors.push(`${argument} requires a value`);
        continue;
      }
      if (argument === "--scheduled-for") {
        if (scheduledFor !== undefined)
          errors.push(`${argument} was specified more than once`);
        scheduledFor = value;
      } else if (argument === "--business-key") {
        if (businessKey !== undefined)
          errors.push(`${argument} was specified more than once`);
        businessKey = value;
      } else if (argument === "--resume-run") {
        if (resumeRunId !== undefined)
          errors.push(`${argument} was specified more than once`);
        resumeRunId = value;
      } else if (argument === "--rerun-from") {
        if (rerunFrom !== undefined)
          errors.push(`${argument} was specified more than once`);
        rerunFrom = value;
      } else if (argument === "--ksql-flow-bin") {
        if (ksqlFlowBin !== undefined)
          errors.push(`${argument} was specified more than once`);
        ksqlFlowBin = value;
      } else if (argument === "--ksql-flow-config") {
        if (ksqlFlowConfig !== undefined)
          errors.push(`${argument} was specified more than once`);
        ksqlFlowConfig = value;
      } else {
        if (ksqlFlowWorkdir !== undefined)
          errors.push(`${argument} was specified more than once`);
        ksqlFlowWorkdir = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) errors.push(`unknown option '${argument}'`);
    else if (networkPath === undefined) networkPath = argument;
    else errors.push(`unexpected argument '${argument}'`);
  }
  if (networkPath === undefined)
    errors.push("run-network requires one <network> path");
  if (
    resumeRunId !== undefined &&
    (scheduledFor !== undefined || businessKey !== undefined || resume)
  ) {
    errors.push(
      "--resume-run must not be combined with --resume, --scheduled-for, or --business-key",
    );
  }
  if (rerunFrom !== undefined && resumeRunId === undefined && !resume) {
    errors.push("--rerun-from requires --resume-run or --resume");
  }
  return {
    resume,
    errors,
    ...(networkPath === undefined ? {} : { networkPath }),
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
    ...(rerunFrom === undefined ? {} : { rerunFrom }),
    ...(ksqlFlowBin === undefined ? {} : { ksqlFlowBin }),
    ...(ksqlFlowConfig === undefined ? {} : { ksqlFlowConfig }),
    ...(ksqlFlowWorkdir === undefined ? {} : { ksqlFlowWorkdir }),
  };
}

function productionDependencies(
  parsed: RunNetworkArguments,
): RunNetworkCommandDependencies {
  const profile = requiredEnvironment("KSQL_FLOWNET_PROFILE");
  const baseUrl = requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(
    /\/$/u,
    "",
  );
  const stateAppId = positiveIntegerEnvironment("KSQL_FLOWNET_STATE_APP_ID");
  const auditAppId = positiveIntegerEnvironment("KSQL_FLOWNET_AUDIT_APP_ID");
  const stateApiToken = requiredEnvironment("KSQL_FLOWNET_STATE_API_TOKEN");
  const auditApiToken = requiredEnvironment("KSQL_FLOWNET_AUDIT_API_TOKEN");
  const command = parsed.ksqlFlowBin ?? requiredEnvironment("KSQL_FLOW_BIN");
  const binArgs = ksqlFlowBinArgsEnvironment();
  const configPath = resolve(
    parsed.ksqlFlowConfig ?? requiredEnvironment("KSQL_FLOW_CONFIG"),
  );
  const executionDirectory = resolve(
    parsed.ksqlFlowWorkdir ?? requiredEnvironment("KSQL_FLOW_WORKDIR"),
  );
  const jobLogAppId = positiveIntegerEnvironment("KSQL_FLOW_LOG_APP_ID");
  const jobLogApiToken = requiredEnvironment("KSQL_FLOW_LOG_API_TOKEN");
  const gracePeriodMs = optionalNonNegativeIntegerEnvironment(
    "KSQL_FLOW_GRACE_PERIOD_MS",
    30_000,
  );
  mkdirSync(executionDirectory, { recursive: true });
  const requestedBy =
    process.env.KSQL_FLOWNET_REQUESTED_BY ?? process.env.USERNAME ?? "unknown";
  const host = process.env.KSQL_FLOWNET_HOST ?? hostname();
  const ownerInstanceId = resolveOwnerInstanceId(host);
  let resources:
    | {
        repository: KintonePersistenceRepository;
        lockManager: NetworkLockManager;
        configPath: string;
      }
    | undefined;
  return {
    profile,
    requestedBy,
    host,
    async invoke(input) {
      const invocationId = `invoke_${randomUUID()}`;
      const loaded = loadNetworkDefinition(input.networkPath);
      if (loaded.definition === undefined || loaded.errors.length > 0) {
        throw new Error("network definition is invalid");
      }
      const repository = new KintonePersistenceRepository({
        baseUrl,
        stateAppId,
        stateApiToken,
        auditAppId,
        auditApiToken,
      });
      const lockManager = new NetworkLockManager({
        baseUrl,
        appId: stateAppId,
        apiToken: stateApiToken,
        profile,
        networkId: loaded.definition.network_id,
        ownerInvocationId: invocationId,
        ownerInstanceId,
        leaseDurationSec: loaded.definition.network_lock.lease_duration_sec,
      });
      const executor = new KsqlFlowCli({
        command,
        binArgs,
        profile,
        configPath,
      });
      const endpoint = `${baseUrl}/k/v1/file.json`;
      const headers = { "X-Cybozu-API-Token": stateApiToken };
      const ensured = await ensureRun({
        ...input,
        invocationId,
        repository,
        lockManager,
        executor,
        bundleStore: {
          upload: (zipBytes) =>
            uploadBundle({ endpoint, zipBytes, fetch, headers }),
          download: (fileKey) =>
            downloadBundle({ endpoint, fileKey, fetch, headers }),
        },
      });
      resources = { repository, lockManager, configPath };
      return ensured;
    },
    async schedule(result) {
      if (result.outcome === "NOOP")
        throw new Error("NO-OP run cannot be scheduled");
      if (resources === undefined)
        throw new Error("scheduler resources are missing");
      const networkBytes = readStoreZip(result.bundleBytes).find(
        ({ name }) => name === "network.yaml",
      )?.data;
      if (networkBytes === undefined)
        throw new Error("bundle has no network.yaml");
      const loaded = loadNetworkDefinitionSource(networkBytes.toString("utf8"));
      if (loaded.definition === undefined || loaded.errors.length > 0)
        throw new Error("stored network definition is invalid");
      const monitor = new LeaseMonitor(resources.lockManager, result.lock, {
        leaseDurationSec: loaded.definition.network_lock.lease_duration_sec,
        heartbeatIntervalSec:
          loaded.definition.network_lock.heartbeat_interval_sec,
      });
      const runner = new RunSubprocess({
        command,
        binArgs,
        executionDirectory,
        timeoutMs:
          result.run.value.resolved_profile_snapshot.limits
            .batch_timeout_sec === null
            ? null
            : result.run.value.resolved_profile_snapshot.limits
                .batch_timeout_sec * 1000,
        gracePeriodMs,
      });
      return runSequentialScheduler({
        run: result.run,
        invocation: result.invocation,
        bundleBytes: result.bundleBytes,
        repository: resources.repository,
        attemptExecutor: new AttemptExecutor({
          repository: resources.repository,
          runner,
          jobLogReader: new KintoneJobLogReader({
            baseUrl,
            appId: jobLogAppId,
            apiToken: jobLogApiToken,
          }),
        }),
        leaseMonitor: monitor,
        profile,
        configPath: resources.configPath,
        executionRoot: executionDirectory,
        close: (finalization) => result.close(finalization),
      });
    },
  };
}

export function resolveOwnerInstanceId(
  host: string,
  configured = process.env.KSQL_FLOWNET_OWNER_INSTANCE_ID,
  pid = process.pid,
): string {
  return configured ?? `local-pid://${host}/${pid}`;
}

export function ksqlFlowBinArgsEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = environment.KSQL_FLOW_BIN_ARGS?.trim();
  if (!raw) return [];
  if (!raw.startsWith("[")) return raw.split(/\s+/u);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("KSQL_FLOW_BIN_ARGS must be a valid JSON string array", {
      cause: error,
    });
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value) => typeof value === "string")
  ) {
    throw new Error("KSQL_FLOW_BIN_ARGS must be a JSON string array");
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
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

function optionalNonNegativeIntegerEnvironment(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "RUN_NETWORK_FAILED";
}
