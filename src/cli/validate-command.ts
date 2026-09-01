import type { ValidationError } from "../domain/network-definition.js";
import {
  validateNetworkPath,
  validateSqlFiles,
} from "../domain/validate-network-path.js";

export { validateNetworkPath, validateSqlFiles };

export function runValidateCommand(networkPath: string): number {
  const validated = validateNetworkPath(networkPath);

  if (validated.errors.length > 0) {
    writeValidationErrors(validated.errors);
    return 1;
  }

  process.stdout.write(`Valid network definition: ${networkPath}\n`);
  return 0;
}

export function writeValidationErrors(
  errors: readonly ValidationError[],
): void {
  process.stderr.write(
    `Network validation failed with ${errors.length} error(s):\n${errors
      .map((error) => `- [${error.code}] ${error.path}: ${error.message}`)
      .join("\n")}\n`,
  );
}
