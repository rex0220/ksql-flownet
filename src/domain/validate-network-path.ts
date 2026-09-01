import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadNetworkDefinition } from "./load-network.js";
import type {
  NetworkDefinition,
  ValidationError,
} from "./network-definition.js";

export interface NetworkPathValidationResult {
  readonly definition?: NetworkDefinition;
  readonly errors: readonly ValidationError[];
}

export function validateSqlFiles(
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
        code: "SQL_FILE_UNREADABLE",
        path: `$.nodes/${index}/sql`,
        message: `SQL file for node '${node.id}' is not readable: ${sqlPath} (${String(error)})`,
      });
    }
  }
  return errors;
}

export function validateNetworkPath(
  networkPath: string,
): NetworkPathValidationResult {
  const loaded = loadNetworkDefinition(networkPath);
  const errors = [...loaded.errors];
  if (loaded.definition !== undefined) {
    errors.push(...validateSqlFiles(networkPath, loaded.definition.nodes));
  }
  return loaded.definition === undefined
    ? { errors }
    : { definition: loaded.definition, errors };
}
