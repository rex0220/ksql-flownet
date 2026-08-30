import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { downloadBundle, uploadBundle } from "../bundle/index.js";
import { loadNetworkDefinition } from "../domain/load-network.js";
import { KsqlFlowCli } from "../executor/ksql-flow-cli.js";
import {
  ensureRun,
  EnsureRunError,
  type EnsureRunInput,
} from "../orchestration/ensure-run.js";
import { KintonePersistenceRepository } from "../persistence/kintone/repository.js";
import { NetworkLockManager } from "../persistence/network-lock.js";

interface RunNetworkArguments {
  readonly networkPath?: string;
  readonly scheduledFor?: string;
  readonly businessKey?: string;
  readonly resume: boolean;
  readonly resumeRunId?: string;
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
    const runtime = dependencies ?? productionDependencies();
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
    });
    if (result.outcome === "NOOP") {
      process.stdout.write(
        `NO-OP: Run ${result.run.value.run_id} is already SUCCESS; nothing was executed.\n`,
      );
      return 0;
    }
    process.stdout.write(
      `${result.outcome}: Run ${result.run.value.run_id} is ready for business key ${result.businessKey}.\n` +
        "Node execution is not implemented until M5; no node was executed. Releasing the Network lock.\n",
    );
    await result.close({
      status: "CANCELLED",
      resultCode: "NODE_EXECUTION_NOT_IMPLEMENTED",
    });
    return 0;
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
      argument === "--resume-run"
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
      } else {
        if (resumeRunId !== undefined)
          errors.push(`${argument} was specified more than once`);
        resumeRunId = value;
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
  return {
    resume,
    errors,
    ...(networkPath === undefined ? {} : { networkPath }),
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
    ...(businessKey === undefined ? {} : { businessKey }),
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
  };
}

function productionDependencies(): RunNetworkCommandDependencies {
  const profile = requiredEnvironment("KSQL_FLOWNET_PROFILE");
  const baseUrl = requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(
    /\/$/u,
    "",
  );
  const stateAppId = positiveIntegerEnvironment("KSQL_FLOWNET_STATE_APP_ID");
  const auditAppId = positiveIntegerEnvironment("KSQL_FLOWNET_AUDIT_APP_ID");
  const stateApiToken = requiredEnvironment("KSQL_FLOWNET_STATE_API_TOKEN");
  const auditApiToken = requiredEnvironment("KSQL_FLOWNET_AUDIT_API_TOKEN");
  const command = requiredEnvironment("KSQL_FLOW_COMMAND");
  const configPath = requiredEnvironment("KSQL_FLOW_CONFIG");
  const requestedBy =
    process.env.KSQL_FLOWNET_REQUESTED_BY ?? process.env.USERNAME ?? "unknown";
  const host = process.env.KSQL_FLOWNET_HOST ?? hostname();
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
        ownerInstanceId: host,
        leaseDurationSec: loaded.definition.network_lock.lease_duration_sec,
      });
      const executor = new KsqlFlowCli({ command, profile, configPath });
      const endpoint = `${baseUrl}/k/v1/file.json`;
      const headers = { "X-Cybozu-API-Token": stateApiToken };
      return ensureRun({
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
    },
  };
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
