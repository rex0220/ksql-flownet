import type { NetworkDefinition } from "../domain/network-definition.js";

export type DescendantsErrorCode =
  "DESCENDANTS_NODE_NOT_FOUND" | "DESCENDANTS_DAG_INVALID";

export class DescendantsError extends Error {
  constructor(
    readonly code: DescendantsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DescendantsError";
  }
}

/** Returns the selected node and all of its transitive descendants in definition order. */
export function descendantsIncludingSelf(
  definition: NetworkDefinition,
  nodeId: string,
): readonly string[] {
  const nodesById = new Map<string, (typeof definition.nodes)[number]>();
  for (const node of definition.nodes) {
    if (nodesById.has(node.id)) {
      throw new DescendantsError(
        "DESCENDANTS_DAG_INVALID",
        `snapshot DAG has duplicate node id '${node.id}'`,
      );
    }
    nodesById.set(node.id, node);
  }
  if (!nodesById.has(nodeId)) {
    throw new DescendantsError(
      "DESCENDANTS_NODE_NOT_FOUND",
      `node '${nodeId}' does not exist in the snapshot DAG`,
    );
  }

  const dependents = new Map(
    definition.nodes.map((node) => [node.id, [] as string[]]),
  );
  const indegree = new Map(
    definition.nodes.map((node) => [node.id, node.depends_on.length]),
  );
  for (const node of definition.nodes) {
    const dependencies = new Set<string>();
    for (const dependency of node.depends_on) {
      if (
        dependency === node.id ||
        dependencies.has(dependency) ||
        !nodesById.has(dependency)
      ) {
        throw new DescendantsError(
          "DESCENDANTS_DAG_INVALID",
          `snapshot DAG has an invalid dependency '${dependency}' for node '${node.id}'`,
        );
      }
      dependencies.add(dependency);
      dependents.get(dependency)!.push(node.id);
    }
  }

  const ready = definition.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift()!;
    visited += 1;
    for (const dependent of dependents.get(current)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== definition.nodes.length) {
    throw new DescendantsError(
      "DESCENDANTS_DAG_INVALID",
      "snapshot DAG contains a cycle",
    );
  }

  const selected = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of dependents.get(current)!) {
      if (selected.has(dependent)) continue;
      selected.add(dependent);
      queue.push(dependent);
    }
  }
  return definition.nodes
    .map((node) => node.id)
    .filter((id) => selected.has(id));
}
