import { setTimeout as delay } from "node:timers/promises";

import {
  createNetworkLockAdapter,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_LEASE_SECONDS,
  makeLockIdentity,
  validateLeaseSettings,
} from "./network-lock-adapter.mjs";
import { positiveIntegerOption, runSpikeMain } from "./script-support.mjs";

export async function runLeaseLifecycle({
  config,
  fetchImplementation = globalThis.fetch,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  heartbeatSeconds = DEFAULT_HEARTBEAT_SECONDS,
  subprocessSeconds = 5,
}) {
  validateLeaseSettings(leaseSeconds, heartbeatSeconds);
  const adapter = createNetworkLockAdapter({ config, fetchImplementation });
  const identity = makeLockIdentity("lifecycle");
  const lock = await adapter.acquire({ identity, leaseSeconds });
  const callsAfterAcquire = adapter.measurements().control_plane_api_calls;
  const started = performance.now();
  const subprocess = delay(subprocessSeconds * 1000, { exitCode: 0 });
  const heartbeats = [];
  let previousHeartbeatAt = started;
  let subprocessResult;
  while (!subprocessResult) {
    const event = await Promise.race([
      subprocess.then((value) => ({ type: "subprocess", value })),
      delay(heartbeatSeconds * 1000).then(() => ({ type: "heartbeat" })),
    ]);
    if (event.type === "subprocess") {
      subprocessResult = event.value;
      break;
    }
    const heartbeatStarted = performance.now();
    await adapter.heartbeat(lock);
    heartbeats.push({
      sequence: heartbeats.length + 1,
      intervalMs: heartbeatStarted - previousHeartbeatAt,
      elapsedMs: heartbeatStarted - started,
      durationMs: performance.now() - heartbeatStarted,
    });
    previousHeartbeatAt = heartbeatStarted;
  }
  const subprocessDurationMs = performance.now() - started;
  const callsAfterHeartbeat = adapter.measurements().control_plane_api_calls;
  const release = await adapter.release(lock);
  const durationMs = performance.now() - started;
  return {
    scenario: "lease-lifecycle",
    measurementIds: ["F-01", "F-02", "F-14"],
    settings: {
      leaseSeconds,
      heartbeatSeconds,
      subprocessSeconds,
      ratioValid: heartbeatSeconds <= leaseSeconds / 3,
      scaledDownForSpike: true,
      productionValuesPendingSpikeDecision: true,
    },
    subprocessResult,
    heartbeat: {
      count: heartbeats.length,
      samples: heartbeats,
      control_plane_api_calls: callsAfterHeartbeat - callsAfterAcquire,
      callsPerExecutionSecond:
        (callsAfterHeartbeat - callsAfterAcquire) /
        (subprocessDurationMs / 1000),
    },
    release,
    measurements: adapter.measurements(),
    subprocessDurationMs,
    durationMs,
    passed:
      subprocessResult.exitCode === 0 &&
      heartbeats.length > 0 &&
      release.released,
  };
}

runSpikeMain(
  import.meta.url,
  ["F-01", "F-02", "F-14"],
  ({ config, arguments_ }) =>
    runLeaseLifecycle({
      config,
      leaseSeconds: positiveIntegerOption(arguments_, "--lease-seconds", 6),
      heartbeatSeconds: positiveIntegerOption(
        arguments_,
        "--heartbeat-seconds",
        2,
      ),
      subprocessSeconds: positiveIntegerOption(
        arguments_,
        "--subprocess-seconds",
        5,
      ),
    }),
);
