import { readFileSync } from "node:fs";

import { changeCancelRequest } from "../orchestration/cancel-request.js";
import type { PersistenceRepository } from "../persistence/repository.js";
import {
  repositoryFromEnvironment,
  requiredEnvironment,
} from "./resolve-node-command.js";

interface Arguments {
  runId?: string;
  reasonFile?: string;
  release: boolean;
  errors: string[];
}

export interface CancelRunCommandDependencies {
  readonly repository: PersistenceRepository;
  readonly requestedBy: string;
  readonly readFile?: (path: string) => string;
  readonly now?: () => Date;
}

export async function runCancelRunCommand(
  args: readonly string[],
  dependencies?: CancelRunCommandDependencies,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.errors.length > 0) {
    process.stderr.write(
      `Invalid cancel-run arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }
  try {
    const runtime = dependencies ?? {
      repository: repositoryFromEnvironment(),
      requestedBy: requiredEnvironment("KSQL_FLOWNET_REQUESTED_BY"),
    };
    const reason = (runtime.readFile ?? ((path) => readFileSync(path, "utf8")))(
      parsed.reasonFile!,
    );
    const result = await changeCancelRequest({
      repository: runtime.repository,
      runId: parsed.runId!,
      requestedBy: runtime.requestedBy,
      reason,
      release: parsed.release,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
    });
    const state = result?.value.state ?? "RELEASED";
    const revision = result === null ? "none" : String(result.revision);
    process.stdout.write(
      `${state}: CANCEL:${parsed.runId} (revision ${revision}).\n`,
    );
    return 0;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "CANCEL_RUN_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    return 1;
  }
}

function parseArguments(args: readonly string[]): Arguments {
  const result: Arguments = { release: false, errors: [] };
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--release") {
      if (result.release)
        result.errors.push("--release was specified more than once");
      result.release = true;
      continue;
    }
    if (argument !== "--run-id" && argument !== "--reason-file") {
      result.errors.push(`unknown option '${argument}'`);
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
  for (const option of ["--run-id", "--reason-file"])
    if (!values.has(option)) result.errors.push(`${option} is required`);
  return {
    ...result,
    ...(values.has("--run-id") ? { runId: values.get("--run-id")! } : {}),
    ...(values.has("--reason-file")
      ? { reasonFile: values.get("--reason-file")! }
      : {}),
  };
}
