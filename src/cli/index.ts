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
  validate         not implemented (FN-02)
  plan             not implemented (FN-02)
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

function failNotImplemented(command: "validate" | "plan"): void {
  process.stderr.write(`Error: ${command} is not implemented (FN-02).\n`);
  process.exitCode = 1;
}

function main(args: readonly string[]): void {
  const [command] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-V") {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  if (command === "validate" || command === "plan") {
    failNotImplemented(command);
    return;
  }

  process.stderr.write(`Error: unknown command '${command}'.\n`);
  process.stderr.write("Run 'ksql-flownet --help' for usage.\n");
  process.exitCode = 1;
}

main(process.argv.slice(2));
