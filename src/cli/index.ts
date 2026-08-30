#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  readonly version: string;
}

const HELP_TEXT = `Usage: ksql-flownet [options] [command]

kSQL-FlowNet Control Plane CLI

Options:
  -h, --help       display help for command
  -V, --version    display version

Commands:
  validate <network>  validate a network definition and its SQL files
  plan <network> [--scheduled-for <timestamp>] [--business-key <key>]
                      display the business key and stable execution plan (read-only)
  run-network <network> [--business-key <key>] [--scheduled-for <timestamp>]
                        [--resume] [--resume-run <run_id>] [--rerun-from <node_id>]
                        [--ksql-flow-bin <path>] [--ksql-flow-config <path>]
                        [--ksql-flow-workdir <path>]
                      ensure and execute a Network Run sequentially
`;

function getVersion(): string {
  const packageJsonPath = fileURLToPath(
    new URL("../../package.json", import.meta.url),
  );
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("package.json does not contain a valid version");
  }

  return (parsed as PackageMetadata).version;
}

function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...commandArgs] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-V") {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  if (command === "validate") {
    if (commandArgs.length !== 1) {
      process.stderr.write(
        "Error: validate requires exactly one <network> path.\n",
      );
      process.exitCode = 1;
      return;
    }
    const { runValidateCommand } = await import("./validate-command.js");
    process.exitCode = runValidateCommand(commandArgs[0] as string);
    return;
  }

  if (command === "plan") {
    const { runPlanCommand } = await import("./plan-command.js");
    process.exitCode = runPlanCommand(commandArgs);
    return;
  }

  if (command === "run-network") {
    const { runRunNetworkCommand } = await import("./run-network-command.js");
    process.exitCode = await runRunNetworkCommand(commandArgs);
    return;
  }

  process.stderr.write(`Error: unknown command '${command}'.\n`);
  process.stderr.write("Run 'ksql-flownet --help' for usage.\n");
  process.exitCode = 1;
}

await main(process.argv.slice(2));
