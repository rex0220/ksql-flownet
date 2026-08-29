import { setTimeout as delay } from "node:timers/promises";

import {
  createNetworkLockAdapter,
  DEFAULT_LEASE_SECONDS,
  isStaleCandidate,
  makeLockIdentity,
} from "./network-lock-adapter.mjs";
import { positiveIntegerOption, runSpikeMain } from "./script-support.mjs";

export async function runStaleDetection({
  config,
  fetchImplementation = globalThis.fetch,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  waitMilliseconds = (leaseSeconds + 1) * 1000,
}) {
  const adapter = createNetworkLockAdapter({ config, fetchImplementation });
  const lock = await adapter.acquire({
    identity: makeLockIdentity("stale"),
    leaseSeconds,
  });
  await delay(waitMilliseconds);
  const beforeObservation = adapter.measurements().execution.apiCalls;
  const revisionBeforeObservation = lock.revision;
  const observed = await adapter.getById(lock.id);
  const observation = isStaleCandidate(observed, new Date());
  const afterObservation = adapter.measurements().execution.apiCalls;
  const persistedRevision = observed.$revision.value;
  const release = await adapter.release(lock, {
    status: "CANCELLED",
    resultCode: "SPIKE_OWNER_CLEANUP_AFTER_OBSERVATION",
  });
  return {
    scenario: "kill-simulation-stale-observer",
    measurementIds: ["F-03"],
    heartbeatStopped: true,
    observation,
    observer: {
      apiCalls: afterObservation - beforeObservation,
      lockWrites: 0,
      persistedRevisionBeforeOwnerCleanup: persistedRevision,
      failClosed: observation.staleCandidate && !observation.reclaimAllowed,
    },
    note: "lease期限超過は死亡確認ではない。観測者は判定のみでlockを更新しない。",
    ownerCleanup: release,
    measurements: adapter.measurements(),
    passed:
      observation.staleCandidate &&
      !observation.ownerStopped &&
      !observation.reclaimAllowed &&
      persistedRevision === revisionBeforeObservation,
  };
}

runSpikeMain(import.meta.url, ["F-03"], ({ config, arguments_ }) =>
  runStaleDetection({
    config,
    leaseSeconds: positiveIntegerOption(arguments_, "--lease-seconds", 6),
  }),
);
