import { stableTopologicalSort } from "../dag/topological-sort.js";
import { resolveBusinessKey } from "../domain/business-key.js";
import {
  validateNetworkPath,
  writeValidationErrors,
} from "./validate-command.js";

interface PlanArguments {
  readonly networkPath?: string;
  readonly scheduledFor?: string;
  readonly businessKey?: string;
  readonly errors: readonly string[];
}

function parsePlanArguments(args: readonly string[]): PlanArguments {
  let networkPath: string | undefined;
  let scheduledFor: string | undefined;
  let businessKey: string | undefined;
  const errors: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--scheduled-for" || argument === "--business-key") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        errors.push(`${argument} requires a value`);
        continue;
      }
      if (argument === "--scheduled-for") {
        if (scheduledFor !== undefined)
          errors.push(`${argument} was specified more than once`);
        scheduledFor = value;
      } else {
        if (businessKey !== undefined)
          errors.push(`${argument} was specified more than once`);
        businessKey = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      errors.push(`unknown option '${argument}'`);
      continue;
    }
    if (networkPath === undefined) networkPath = argument;
    else errors.push(`unexpected argument '${argument}'`);
  }

  if (networkPath === undefined)
    errors.push("plan requires one <network> path");
  const result: PlanArguments = { errors };
  if (networkPath !== undefined) Object.assign(result, { networkPath });
  if (scheduledFor !== undefined) Object.assign(result, { scheduledFor });
  if (businessKey !== undefined) Object.assign(result, { businessKey });
  return result;
}

export function runPlanCommand(args: readonly string[]): number {
  const parsed = parsePlanArguments(args);
  if (parsed.errors.length > 0 || parsed.networkPath === undefined) {
    process.stderr.write(
      `Invalid plan arguments:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}\n`,
    );
    return 1;
  }

  const validated = validateNetworkPath(parsed.networkPath);
  const errors = [...validated.errors];
  let businessKey: string | undefined;
  if (validated.definition !== undefined) {
    const input = {
      networkId: validated.definition.network_id,
      policy: validated.definition.business_key_policy,
      ...(parsed.scheduledFor === undefined
        ? {}
        : { scheduledFor: parsed.scheduledFor }),
      ...(parsed.businessKey === undefined
        ? {}
        : { businessKey: parsed.businessKey }),
    };
    const resolved = resolveBusinessKey(input);
    for (const error of resolved.errors) {
      if (
        !errors.some(
          (existing) =>
            existing.code === error.code &&
            existing.path === error.path &&
            existing.message === error.message,
        )
      ) {
        errors.push(error);
      }
    }
    businessKey = resolved.businessKey;
  }

  if (errors.length > 0) {
    writeValidationErrors(errors);
    return 1;
  }
  if (validated.definition === undefined || businessKey === undefined) {
    process.stderr.write("Error: plan could not be produced.\n");
    return 1;
  }

  const nodeById = new Map(
    validated.definition.nodes.map((node) => [node.id, node]),
  );
  const order = stableTopologicalSort(validated.definition.nodes).order;
  const lines = order.map((nodeId, index) => {
    const node = nodeById.get(nodeId);
    if (node === undefined) throw new Error(`missing sorted node '${nodeId}'`);
    const dependencies =
      node.depends_on.length === 0 ? "-" : node.depends_on.join(", ");
    return `${index + 1}. ${node.id} | job_id=${node.job_id} | idempotent=${String(node.idempotent)} | depends_on=${dependencies}`;
  });
  process.stdout.write(
    `Business key: ${businessKey}\nExecution plan:\n${lines.join("\n")}\n`,
  );
  return 0;
}
