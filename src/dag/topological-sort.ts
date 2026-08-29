import type { NetworkNodeDefinition } from "../domain/network-definition.js";

export interface TopologicalSortResult {
  readonly order: readonly string[];
  readonly cyclicNodeIds: readonly string[];
}

export function stableTopologicalSort(
  nodes: readonly NetworkNodeDefinition[],
): TopologicalSortResult {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(
    nodes.map((node) => [node.id, node.depends_on.length]),
  );
  const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));

  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      dependents.get(dependency)?.push(node.id);
    }
  }

  const ready = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort(
      (left, right) => (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0),
    );
    const current = ready.shift();
    if (current === undefined) break;
    order.push(current);

    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  const cyclicNodeIds = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) > 0)
    .map((node) => node.id);
  return { order, cyclicNodeIds };
}
