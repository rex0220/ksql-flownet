import { readFileSync } from "node:fs";

import {
  forceUnlockNetwork,
  type NetworkLockRecoveryDependencies,
} from "../persistence/network-lock-recovery.js";
import {
  repositoryFromEnvironment,
  requiredEnvironment,
} from "./resolve-node-command.js";

interface Arguments {
  readonly networkId?: string;
  readonly profile?: string;
  readonly expectedOwnerInvocationId?: string;
  readonly reasonFile?: string;
  readonly evidenceRef?: string;
  readonly stopConfirmedBy?: string;
  readonly stopEvidenceRef?: string;
  readonly stopMethod?: string;
  readonly errors: string[];
}

export interface ForceUnlockNetworkCommandDependencies extends NetworkLockRecoveryDependencies {
  readonly servicePrincipal: string;
  readonly requestedBy: string;
  readonly readFile?: (path: string) => string;
}

export async function runForceUnlockNetworkCommand(
  args: readonly string[],
  dependencies?: ForceUnlockNetworkCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.errors.length > 0) {
    process.stderr.write(
      `Invalid force-unlock-network arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const runtime = dependencies ?? productionDependencies();
    const reason = (runtime.readFile ?? ((path) => readFileSync(path, "utf8")))(
      parsed.reasonFile!,
    );
    const result = await forceUnlockNetwork(
      {
        networkId: parsed.networkId!,
        profile: parsed.profile!,
        expectedOwnerInvocationId: parsed.expectedOwnerInvocationId!,
        reason,
        evidenceRef: parsed.evidenceRef!,
        stopConfirmedBy: parsed.stopConfirmedBy!,
        stopEvidenceRef: parsed.stopEvidenceRef!,
        stopMethod: parsed.stopMethod!,
        servicePrincipal: runtime.servicePrincipal,
        requestedBy: runtime.requestedBy,
      },
      runtime,
    );
    process.stdout.write(
      `RELEASED: ${result.lockKey} (previous owner ${result.previousOwnerInvocationId}, post revision ${result.postReleaseRevision}).\n`,
    );
    process.stdout.write(
      "If a Node was running, use resolve-node to resolve it as UNKNOWN before resume.\n",
    );
    return 0;
  } catch (error) {
    const code = errorCode(error, "FORCE_UNLOCK_NETWORK_FAILED");
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    return 1;
  }
}

function parseArguments(args: readonly string[]): Arguments {
  const errors: string[] = [];
  const positional: string[] = [];
  const values = new Map<string, string>();
  const allowed = new Set([
    "--profile",
    "--expected-owner-invocation-id",
    "--reason-file",
    "--evidence-ref",
    "--stop-confirmed-by",
    "--stop-evidence-ref",
    "--stop-method",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${argument} requires a value`);
      continue;
    }
    if (!allowed.has(argument)) errors.push(`unknown option '${argument}'`);
    if (values.has(argument))
      errors.push(`${argument} was specified more than once`);
    values.set(argument, value);
    index += 1;
  }
  if (positional.length === 0) errors.push("<network_id> is required");
  if (positional.length > 1) {
    for (const argument of positional.slice(1))
      errors.push(`unexpected argument '${argument}'`);
  }
  for (const option of allowed) {
    if (!values.has(option)) errors.push(`${option} is required`);
  }
  return {
    ...(positional[0] === undefined ? {} : { networkId: positional[0] }),
    ...(values.get("--profile") === undefined
      ? {}
      : { profile: values.get("--profile")! }),
    ...(values.get("--expected-owner-invocation-id") === undefined
      ? {}
      : {
          expectedOwnerInvocationId: values.get(
            "--expected-owner-invocation-id",
          )!,
        }),
    ...(values.get("--reason-file") === undefined
      ? {}
      : { reasonFile: values.get("--reason-file")! }),
    ...(values.get("--evidence-ref") === undefined
      ? {}
      : { evidenceRef: values.get("--evidence-ref")! }),
    ...(values.get("--stop-confirmed-by") === undefined
      ? {}
      : { stopConfirmedBy: values.get("--stop-confirmed-by")! }),
    ...(values.get("--stop-evidence-ref") === undefined
      ? {}
      : { stopEvidenceRef: values.get("--stop-evidence-ref")! }),
    ...(values.get("--stop-method") === undefined
      ? {}
      : { stopMethod: values.get("--stop-method")! }),
    errors,
  };
}

function productionDependencies(): ForceUnlockNetworkCommandDependencies {
  return {
    baseUrl: requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(/\/$/u, ""),
    stateAppId: positiveIntegerEnvironment("KSQL_FLOWNET_STATE_APP_ID"),
    stateApiToken: requiredEnvironment("KSQL_FLOWNET_STATE_API_TOKEN"),
    repository: repositoryFromEnvironment(),
    servicePrincipal: requiredEnvironment("KSQL_FLOWNET_SERVICE_PRINCIPAL"),
    requestedBy: requiredEnvironment("KSQL_FLOWNET_REQUESTED_BY"),
  };
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
