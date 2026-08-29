import { createHash, randomUUID } from "node:crypto";

export const DAG_NODES = Object.freeze([
  Object.freeze({
    nodeId: "extract",
    jobId: "spike_a_extract",
    dependsOn: [],
    idempotent: true,
  }),
  Object.freeze({
    nodeId: "aggregate",
    jobId: "spike_a_aggregate",
    dependsOn: ["extract"],
    idempotent: true,
  }),
  Object.freeze({
    nodeId: "send",
    jobId: "spike_a_send",
    dependsOn: ["aggregate"],
    idempotent: true,
  }),
]);

function canonicalKey(version, parts) {
  const input = `${version}\0${parts
    .map((part) => String(part).normalize("NFC"))
    .join("\0")}`;
  const digest = createHash("sha256").update(input, "utf8").digest("base64url");
  return `${version}:${digest}`;
}

export function createDataset(scenario, nonce = randomUUID()) {
  const shortNonce = createHash("sha256")
    .update(`${scenario}\0${nonce}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  const runId = `spike_a_${scenario.replaceAll("-", "_")}_${shortNonce}`;
  const networkId = "spike_a_serial_3";
  const profile = "spike-a";
  const invocationId = `invoke_new_${shortNonce}`;
  const lockKey = canonicalKey("N1", [profile, networkId]);
  const baseTime = Date.parse("2026-08-29T00:00:00.000Z");
  let tick = 0;

  return {
    scenario,
    nonce,
    runId,
    networkId,
    profile,
    businessKey: `${networkId}@${shortNonce}`,
    invocationId,
    lockKey,
    nodes: DAG_NODES.map((node) => ({
      ...node,
      nodeStateId: `state_${shortNonce}_${node.nodeId}`,
      nodeStateKey: canonicalKey("S1", [runId, node.nodeId]),
    })),
    attemptKey(nodeId, attemptNo) {
      return canonicalKey("A1", [runId, nodeId, attemptNo]);
    },
    attemptId(nodeId, attemptNo) {
      return `attempt_${shortNonce}_${nodeId}_${attemptNo}`;
    },
    resumeInvocationId: `invoke_resume_${shortNonce}`,
    now() {
      const value = new Date(baseTime + tick * 1000).toISOString();
      tick += 1;
      return value;
    },
  };
}
