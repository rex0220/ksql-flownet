import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadNetworkDefinition } from "../domain/load-network.js";
import type { ValidationError } from "../domain/network-definition.js";

function validateSqlFiles(
  networkPath: string,
  nodes: readonly { readonly id: string; readonly sql: string }[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [index, node] of nodes.entries()) {
    const sqlPath = resolve(dirname(networkPath), node.sql);
    try {
      accessSync(sqlPath, constants.R_OK);
      if (!statSync(sqlPath).isFile()) throw new Error("path is not a file");
    } catch (error) {
      errors.push({
        path: `$.nodes/${index}/sql`,
        message: `SQL file for node '${node.id}' is not readable: ${sqlPath} (${String(error)})`,
      });
    }
  }
  return errors;
}

export function runValidateCommand(networkPath: string): number {
  const loaded = loadNetworkDefinition(networkPath);
  const errors = [...loaded.errors];
  if (loaded.definition !== undefined) {
    errors.push(...validateSqlFiles(networkPath, loaded.definition.nodes));
  }

  if (errors.length > 0) {
    process.stderr.write(
      `Network validation failed with ${errors.length} error(s):\n${errors
        .map((error) => `- ${error.path}: ${error.message}`)
        .join("\n")}\n`,
    );
    return 1;
  }

  process.stdout.write(`Valid network definition: ${networkPath}\n`);
  return 0;
}
