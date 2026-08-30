import {
  inspectStatus,
  type StatusDependencies,
  type StatusOutput,
} from "../orchestration/status.js";
import { KintoneNetworkLockStatusReader } from "../persistence/network-lock-reader.js";
import {
  repositoryFromEnvironment,
  requiredEnvironment,
} from "./resolve-node-command.js";

interface StatusArguments {
  readonly networkId?: string;
  readonly profile?: string;
  readonly runId?: string;
  readonly businessKey?: string;
  readonly json: boolean;
  readonly errors: readonly string[];
}

export type StatusCommandDependencies = StatusDependencies;

export async function runStatusCommand(
  args: readonly string[],
  dependencies?: StatusCommandDependencies,
): Promise<number> {
  const parsed = parseStatusArguments(args);
  if (parsed.errors.length > 0) {
    process.stderr.write(
      `Invalid status arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const result = await inspectStatus(
      {
        networkId: parsed.networkId!,
        profile: parsed.profile!,
        ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
        ...(parsed.businessKey === undefined
          ? {}
          : { businessKey: parsed.businessKey }),
      },
      dependencies ?? productionDependencies(),
    );
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderStatusText(result),
    );
    return 0;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "STATUS_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    return 1;
  }
}

function parseStatusArguments(args: readonly string[]): StatusArguments {
  const errors: string[] = [];
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  const valueOptions = new Set(["--profile", "--run-id", "--business-key"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      if (json) errors.push("--json was specified more than once");
      json = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (!valueOptions.has(argument)) {
      errors.push(`unknown option '${argument}'`);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${argument} requires a value`);
      continue;
    }
    if (values.has(argument)) {
      errors.push(`${argument} was specified more than once`);
    }
    values.set(argument, value);
    index += 1;
  }
  if (positional.length === 0) errors.push("<network_id> is required");
  for (const argument of positional.slice(1)) {
    errors.push(`unexpected argument '${argument}'`);
  }
  if (!values.has("--profile")) errors.push("--profile is required");
  if (values.has("--run-id") && values.has("--business-key")) {
    errors.push("--run-id and --business-key are mutually exclusive");
  }
  return {
    json,
    errors,
    ...(positional[0] === undefined ? {} : { networkId: positional[0] }),
    ...(values.has("--profile") ? { profile: values.get("--profile")! } : {}),
    ...(values.has("--run-id") ? { runId: values.get("--run-id")! } : {}),
    ...(values.has("--business-key")
      ? { businessKey: values.get("--business-key")! }
      : {}),
  };
}

export function renderStatusText(output: StatusOutput): string {
  const lines = [`Network: ${output.network_id}`, `Profile: ${output.profile}`];
  if (output.lock === null) {
    lines.push("Lock: none");
  } else {
    lines.push("Lock:");
    for (const [key, value] of Object.entries(output.lock)) {
      lines.push(`  ${key}: ${String(value)}`);
    }
  }
  lines.push(`Runs: ${output.runs.length}`);
  for (const run of output.runs) {
    lines.push(`- run_id: ${run.run_id}`);
    for (const [key, value] of Object.entries(run)) {
      if (key === "run_id") continue;
      if (typeof value === "object" && value !== null) {
        lines.push(`  ${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`  ${key}: ${String(value)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function productionDependencies(): StatusCommandDependencies {
  const baseUrl = requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(
    /\/$/u,
    "",
  );
  const stateAppId = positiveIntegerEnvironment("KSQL_FLOWNET_STATE_APP_ID");
  const stateApiToken = requiredEnvironment("KSQL_FLOWNET_STATE_API_TOKEN");
  return {
    repository: repositoryFromEnvironment(),
    lockReader: new KintoneNetworkLockStatusReader({
      baseUrl,
      stateAppId,
      stateApiToken,
    }),
  };
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
