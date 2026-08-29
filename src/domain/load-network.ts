import { readFileSync } from "node:fs";

import { parseDocument } from "yaml";

import type {
  ValidationError,
  ValidationResult,
} from "./network-definition.js";
import { validateNetworkDefinition } from "./validate-network.js";

export function loadNetworkDefinition(path: string): ValidationResult {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return {
      errors: [
        {
          code: "NETWORK_FILE_UNREADABLE",
          path: "$",
          message: `cannot read network file: ${String(error)}`,
        },
      ],
    };
  }

  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    const errors: ValidationError[] = document.errors.map((error) => ({
      code: "YAML_PARSE_ERROR",
      path: "$",
      message: `invalid YAML: ${error.message}`,
    }));
    return { errors };
  }
  try {
    return validateNetworkDefinition(document.toJS());
  } catch (error) {
    return {
      errors: [
        {
          code: "YAML_VALUE_INVALID",
          path: "$",
          message: `invalid YAML value: ${String(error)}`,
        },
      ],
    };
  }
}
