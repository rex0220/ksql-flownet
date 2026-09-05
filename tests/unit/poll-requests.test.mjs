import assert from "node:assert/strict";
import test from "node:test";

import {
  hasLiveOwner,
  pollRequests,
  reviewRequest,
} from "../../dist/requests/request-poller.js";

const nowText = "2026-08-31T02:00:00Z";
const nowMs = Date.parse(nowText);

function request(overrides = {}) {
  return {
    id: "42",
    revision: 3,
    creatorCode: "operator@example.test",
    createdAt: "2026-08-31T01:00:00Z",
    requestType: "RERUN",
    runId: "run-42",
    rerunFromNode: null,
    reason: "investigated",
    requestState: "REQUESTED",
    claimedAt: null,
    claimedHost: null,
    claimHeartbeatAt: null,
    resultCode: null,
    resultMessage: null,
    cancelRequested: false,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    run_id: "run-42",
    business_key: "net@42",
    status: "FAILED",
    resume_allowed: true,
    lifecycle_status: "ACTIVE",
    created_at: "2026-08-31T00:00:00Z",
    started_at: "2026-08-31T00:01:00Z",
    finished_at: "2026-08-31T00:02:00Z",
    updated_at: "2026-08-31T00:02:00Z",
    hold: null,
    invocations: [
      {
        invocation_id: "invoke-old",
        mode: "RESUME",
        status: "FAILED",
        result_code: "FAILED",
      },
    ],
    ...overrides,
  };
}

function status(runValue = run(), overrides = {}) {
  return {
    network_id: "net-a",
    profile: "prod",
    lock: null,
    runs: [runValue],
    ...overrides,
  };
}

const config = {
  networks: [
    { networkId: "net-a", definitionPath: "C:\\net-a.yaml", appStart: false },
    { networkId: "net-b", definitionPath: "C:\\net-b.yaml", appStart: false },
  ],
  heartbeatIntervalMs: 100,
  staleAfterMs: 900_000,
  stalePrecisionAllowanceMs: 60_000,
};

function accepted(value) {
  return {
    ...value,
    revision: value.revision + 1,
    requestState: "ACCEPTED",
    claimedAt: nowText,
    claimedHost: "poller-a",
    claimHeartbeatAt: value.claimHeartbeatAt ?? nowText,
  };
}

function harness({
  requested = [],
  acceptedRecords = [],
  statusFor,
  runNetwork,
  cancelRun,
} = {}) {
  const calls = [];
  const results = [];
  const store = {
    async listAccepted() {
      calls.push("listAccepted");
      return acceptedRecords;
    },
    async listRequested() {
      calls.push("listRequested");
      return { valid: requested, invalid: [], skipped: 0 };
    },
    async rejectInvalid() {},
    async cancelBeforeClaim() {
      return true;
    },
    async claim(value) {
      calls.push(`claim:${value.id}`);
      return accepted(value);
    },
    async heartbeat(value, heartbeatAt) {
      calls.push(`heartbeat:${value.id}`);
      return {
        ...value,
        revision: value.revision + 1,
        claimHeartbeatAt: heartbeatAt,
      };
    },
    async getById(id) {
      const value = requested.find((candidate) => candidate.id === id);
      return value === undefined ? null : accepted(value);
    },
    async writeResult(value, result) {
      calls.push(`result:${value.id}:${result.code}`);
      results.push({ value, result });
      return { ...value, requestState: result.state };
    },
  };
  const child = {
    async status(network, runId) {
      calls.push(`status:${network.networkId}:${runId}`);
      return statusFor === undefined
        ? network.networkId === "net-a"
          ? status()
          : null
        : statusFor(network, runId);
    },
    async runNetwork(network, value) {
      calls.push(`run:${value.id}:${network.networkId}`);
      return (
        runNetwork?.(network, value) ?? {
          output: {
            outcome: "RESUME",
            run_id: value.runId,
            invocation_id: `invoke-${value.id}`,
            aggregate_status: "SUCCESS",
            invocation_result_code: "OK",
          },
          process: {
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        }
      );
    },
    async cancelRun(value, release) {
      calls.push(`cancel:${value.id}:${release}`);
      return (
        cancelRun?.(value, release) ?? {
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      );
    },
    async archiveRun(_network, value) {
      calls.push(`archive:${value.id}`);
      return {
        output: {
          outcome: "ARCHIVED",
          run_id: value.runId,
          event_id: `archive-${value.id}`,
          run_revision: 4,
          audit: "RECORDED",
          lock_released: true,
        },
        process: {
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      };
    },
  };
  return { calls, results, store, child };
}

test("RERUN/STOP/RELEASEの許可・拒否matrixを固定する", () => {
  for (const runStatus of ["CREATED", "RUNNING", "FAILED", "CANCELLED"]) {
    assert.equal(
      reviewRequest(
        { requestType: "RERUN" },
        { status: status(), run: run({ status: runStatus }) },
        nowMs,
        60_000,
      ),
      null,
    );
  }
  for (const runStatus of ["SUCCESS", "UNKNOWN"]) {
    assert.equal(
      reviewRequest(
        { requestType: "RERUN" },
        { status: status(), run: run({ status: runStatus }) },
        nowMs,
        60_000,
      ).code,
      "RUN_STATUS_NOT_RERUNNABLE",
    );
  }
  assert.equal(
    reviewRequest(
      { requestType: "RERUN" },
      { status: status(), run: run({ resume_allowed: false }) },
      nowMs,
      60_000,
    ).code,
    "RUN_NOT_RESUMABLE",
  );
  assert.equal(
    reviewRequest(
      { requestType: "RERUN" },
      { status: status(), run: run({ lifecycle_status: "ARCHIVED" }) },
      nowMs,
      60_000,
    ).code,
    "RUN_NOT_RESUMABLE",
  );
  assert.equal(
    reviewRequest(
      { requestType: "RERUN" },
      { status: status(), run: run({ activity: "STOPPED" }) },
      nowMs,
      60_000,
    ).code,
    "RUN_ON_HOLD",
  );
  assert.equal(
    reviewRequest(
      { requestType: "RERUN" },
      { status: status(), run: run({ status: "RUNNING", activity: "LIVE" }) },
      nowMs,
      60_000,
    ).code,
    "RUN_LIVE",
  );

  for (const runStatus of ["CREATED", "RUNNING"]) {
    assert.equal(
      reviewRequest(
        { requestType: "STOP" },
        { status: status(), run: run({ status: runStatus }) },
        nowMs,
        60_000,
      ),
      null,
    );
  }
  for (const runStatus of ["SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"]) {
    assert.equal(
      reviewRequest(
        { requestType: "STOP" },
        { status: status(), run: run({ status: runStatus }) },
        nowMs,
        60_000,
      ).code,
      "RUN_TERMINAL",
    );
  }
  assert.equal(
    reviewRequest(
      { requestType: "STOP" },
      {
        status: status(),
        run: run({
          status: "RUNNING",
          activity: "STOPPED",
          hold: {
            state: "ACCEPTED",
            requested_by: "operator",
            requested_at: nowText,
          },
        }),
      },
      nowMs,
      60_000,
    ).code,
    "RUN_ALREADY_ON_HOLD",
  );
  assert.equal(
    reviewRequest(
      { requestType: "RELEASE" },
      {
        status: status(),
        run: run({
          status: "RUNNING",
          activity: "STOPPED",
          hold: {
            state: "ACCEPTED",
            requested_by: "operator",
            requested_at: nowText,
          },
        }),
      },
      nowMs,
      60_000,
    ),
    null,
  );
  assert.equal(
    reviewRequest(
      { requestType: "RELEASE" },
      { status: status(), run: run({ status: "RUNNING", activity: "IDLE" }) },
      nowMs,
      60_000,
    ).code,
    "RUN_NOT_ON_HOLD",
  );
});

test("RERUNはholdありを拒否しRELEASEは終端Runでもholdだけを条件に受理する", () => {
  const hold = {
    state: "REQUESTED",
    requested_by: "operator",
    requested_at: nowText,
  };
  assert.equal(
    reviewRequest(
      { requestType: "RERUN" },
      { status: status(), run: run({ hold }) },
      nowMs,
      60_000,
    ).code,
    "RUN_ON_HOLD",
  );
  assert.equal(
    reviewRequest(
      { requestType: "RELEASE" },
      { status: status(), run: run({ status: "FAILED", hold }) },
      nowMs,
      60_000,
    ),
    null,
  );
  assert.equal(
    reviewRequest(
      { requestType: "RELEASE" },
      { status: status(), run: run({ status: "FAILED", hold: null }) },
      nowMs,
      60_000,
    ).code,
    "RUN_NOT_ON_HOLD",
  );
});

test("CLOSE一次審査はARCHIVED/SUCCESS/UNKNOWN/非終端/hold/liveの順で裁定する", () => {
  const close = { requestType: "CLOSE" };
  const hold = {
    state: "ACCEPTED",
    requested_by: "operator",
    requested_at: nowText,
  };
  const liveStatus = status(undefined, {
    lock: {
      record_id: "1",
      owner_invocation_id: "invoke-old",
      owner_instance_id: "host",
      heartbeat_at: nowText,
      lease_expires_at: nowText,
      stale_candidate: false,
      revision: 2,
    },
  });
  const cases = [
    [
      run({ lifecycle_status: "ARCHIVED", status: "SUCCESS", hold }),
      "RUN_ALREADY_ARCHIVED",
      "DONE",
    ],
    [run({ status: "SUCCESS", hold }), "RUN_STATUS_NOT_CLOSABLE", "REJECTED"],
    [run({ status: "UNKNOWN", hold }), "RUN_UNKNOWN_NOT_CLOSABLE", "REJECTED"],
    [run({ status: "CREATED", hold }), "RUN_NOT_TERMINAL", "REJECTED"],
    [run({ status: "RUNNING", hold }), "RUN_NOT_TERMINAL", "REJECTED"],
    [run({ status: "FAILED", hold }), "RUN_ON_HOLD", "REJECTED"],
    [run({ status: "FAILED" }), null, null],
  ];
  for (const [runValue, code, state] of cases) {
    const actual = reviewRequest(
      close,
      { status: status(runValue), run: runValue },
      nowMs,
      60_000,
    );
    assert.equal(actual?.code ?? null, code);
    assert.equal(actual?.state ?? null, state);
  }
  const liveRun = run({ status: "FAILED" });
  assert.equal(
    reviewRequest(
      close,
      { status: { ...liveStatus, runs: [liveRun] }, run: liveRun },
      nowMs,
      60_000,
    ).code,
    "RUN_LIVE",
  );
});

test("終端activity欠落でもowner所属とlease分精度境界でLIVE判定する", () => {
  const terminal = run({ activity: undefined });
  const lockStatus = status(terminal, {
    lock: {
      record_id: "1",
      owner_invocation_id: "invoke-old",
      owner_instance_id: "host",
      heartbeat_at: nowText,
      lease_expires_at: "2026-08-31T01:59:00Z",
      stale_candidate: false,
      revision: 2,
    },
  });
  assert.equal(hasLiveOwner(lockStatus, terminal, nowMs, 60_000), true);
  assert.equal(hasLiveOwner(lockStatus, terminal, nowMs + 1, 60_000), false);
  assert.equal(
    reviewRequest(
      { requestType: "RERUN" },
      { status: lockStatus, run: terminal },
      nowMs,
      60_000,
    ).code,
    "RUN_LIVE",
  );
});

test("status JSON解決は0件/1件/複数件をfail-closedに分類する", async () => {
  for (const [mode, expected] of [
    ["zero", "RUN_NOT_FOUND"],
    ["one", "OK"],
    ["many", "RUN_ID_AMBIGUOUS"],
  ]) {
    const h = harness({
      requested: [request()],
      statusFor(network) {
        if (mode === "zero") return null;
        if (mode === "one")
          return network.networkId === "net-a" ? status() : null;
        return status(run(), { network_id: network.networkId });
      },
    });
    await pollRequests({
      store: h.store,
      child: h.child,
      config,
      host: "poller",
      now: () => new Date(nowText),
    });
    assert.equal(h.results[0].result.code, expected);
  }
});

test("不正要求はrevision指定で個別REJECTED、識別不能件数だけlogする", async () => {
  const rejected = [];
  const logs = [];
  const h = harness();
  h.store.listRequested = async () => ({
    valid: [],
    invalid: [
      {
        id: "50",
        revision: 7,
        issues: [{ code: "REQUIRED", field: "reason", message: "blank" }],
      },
    ],
    skipped: 2,
  });
  h.store.rejectInvalid = async (identity, result) =>
    rejected.push({ identity, result });
  const summary = await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
    log: (code, detail) => logs.push({ code, detail }),
  });
  assert.deepEqual(rejected[0].identity, {
    id: "50",
    revision: 7,
    issues: [{ code: "REQUIRED", field: "reason", message: "blank" }],
  });
  assert.equal(rejected[0].result.code, "REQUEST_INVALID");
  assert.deepEqual(logs, [
    { code: "REQUEST_RECORD_UNIDENTIFIABLE", detail: "count=2" },
  ]);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.skippedMalformed, 2);
});

test("valid/invalidのclaim前取消を優先し競合時は警告して周期内で触らない", async () => {
  const logs = [];
  const rejected = [];
  const cancelled = [];
  const h = harness({
    requested: [request({ id: "51", cancelRequested: true })],
  });
  h.store.listRequested = async () => ({
    valid: [request({ id: "51", cancelRequested: true })],
    invalid: [
      {
        id: "50",
        revision: 7,
        requestState: "REQUESTED",
        cancelRequested: true,
        issues: [{ code: "REQUIRED", field: "reason", message: "blank" }],
      },
      {
        id: "52",
        revision: 8,
        requestState: "REQUESTED",
        cancelRequested: "INVALID",
        issues: [
          { code: "INVALID_VALUE", field: "cancel_requested", message: "bad" },
        ],
      },
      {
        id: "53",
        revision: 9,
        requestState: "REQUESTED",
        cancelRequested: true,
        issues: [{ code: "REQUIRED", field: "reason", message: "blank" }],
      },
    ],
    skipped: 0,
  });
  h.store.cancelBeforeClaim = async (identity, result) => {
    cancelled.push({ identity, result });
    return identity.id !== "53";
  };
  h.store.rejectInvalid = async (identity, result) =>
    rejected.push({ identity, result });
  const summary = await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
    log: (code, detail) => logs.push({ code, detail }),
  });
  assert.deepEqual(
    cancelled.map(({ identity }) => identity.id),
    ["50", "53", "51"],
  );
  assert.equal(
    cancelled.every(({ result }) => result.state === "CANCELLED"),
    true,
  );
  assert.deepEqual(
    rejected.map(({ identity }) => identity.id),
    ["52"],
  );
  assert.equal(rejected[0].result.code, "REQUEST_INVALID");
  assert.equal(summary.cancelled, 2);
  assert.equal(
    h.calls.some((value) => value.startsWith("claim:")),
    false,
  );
  assert.deepEqual(logs, [
    { code: "CANCEL_FINALIZE_CONFLICT", detail: "request_id=53" },
  ]);
});

test("終端直前再GETのcancelを付記し終端後の変更は遡及反映しない", async () => {
  const h = harness({ requested: [request()] });
  h.store.getById = async () =>
    accepted(request({ revision: 10, cancelRequested: true }));
  await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.match(h.results[0].result.message, /\(cancel_ignored\)$/u);
  assert.equal(h.results[0].value.revision, 11);
  assert.equal(h.results.length, 1);
});

test("終端再GET/PUT失敗はACCEPTEDを残して次要求へ進みheartbeatを再開しない", async () => {
  for (const failure of ["get", "put"]) {
    const logs = [];
    const h = harness({
      requested: [request({ id: "1" }), request({ id: "2" })],
    });
    const originalGet = h.store.getById;
    const originalWrite = h.store.writeResult;
    h.store.getById = async (id) => {
      if (id === "1" && failure === "get") throw new Error("GET failed");
      return originalGet(id);
    };
    h.store.writeResult = async (value, result) => {
      if (value.id === "1" && failure === "put") throw new Error("PUT failed");
      return originalWrite(value, result);
    };
    const summary = await pollRequests({
      store: h.store,
      child: h.child,
      config,
      host: "poller",
      now: () => new Date(nowText),
      log: (code, detail) => logs.push({ code, detail }),
    });
    assert.equal(summary.claimed, 2);
    assert.equal(summary.completed, 1);
    assert.deepEqual(logs, [
      { code: "RESULT_FINALIZE_ABANDONED", detail: "request_id=1" },
    ]);
    assert.equal(h.calls.filter((value) => value === "heartbeat:1").length, 0);
    assert.equal(
      h.results.some(({ value }) => value.id === "2"),
      true,
    );
  }
});

test("終端再GETがACCEPTED以外ならRESULT_STATE_MISMATCHで更新しない", async () => {
  const logs = [];
  const h = harness({ requested: [request()] });
  h.store.getById = async () => request({ requestState: "DONE" });
  const summary = await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
    log: (code, detail) => logs.push({ code, detail }),
  });
  assert.equal(summary.completed, 0);
  assert.equal(h.results.length, 0);
  assert.deepEqual(logs, [
    { code: "RESULT_STATE_MISMATCH", detail: "request_id=42" },
  ]);
});

test("ARCHIVEDを一次審査で観測したCLOSEはchild未起動でDONEになる", async () => {
  const h = harness({
    requested: [request({ requestType: "CLOSE" })],
    statusFor(network) {
      return network.networkId === "net-a"
        ? status(run({ lifecycle_status: "ARCHIVED" }))
        : null;
    },
  });
  await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.equal(h.results[0].result.code, "RUN_ALREADY_ARCHIVED");
  assert.equal(
    h.calls.some((value) => value.startsWith("archive:")),
    false,
  );
});

test("closableなCLOSEはarchive-run childを起動してRUN_ARCHIVEDで終端する", async () => {
  const h = harness({ requested: [request({ requestType: "CLOSE" })] });
  await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.deepEqual(
    h.calls.filter((value) => value.startsWith("archive:")),
    ["archive:42"],
  );
  assert.equal(h.results[0].result.state, "DONE");
  assert.equal(h.results[0].result.code, "RUN_ARCHIVED");
  assert.match(h.results[0].result.message, /event_id=archive-42/u);
});

test("REQUESTED一覧GET失敗時はstale書込もchild起動もしない", async () => {
  const h = harness({
    acceptedRecords: [
      accepted(request({ claimHeartbeatAt: "2026-08-31T01:00:00Z" })),
    ],
  });
  h.store.listRequested = async () => {
    throw new Error("GET failed");
  };
  await assert.rejects(
    pollRequests({
      store: h.store,
      child: h.child,
      config,
      host: "poller",
      now: () => new Date(nowText),
    }),
    /GET failed/u,
  );
  assert.equal(
    h.calls.some(
      (value) =>
        value.startsWith("status:") ||
        value.startsWith("result:") ||
        value.startsWith("run:"),
    ),
    false,
  );
});

test("過長creator相関はchildを起動せずREJECTEDにする", async () => {
  const h = harness({
    requested: [request({ creatorCode: "界".repeat(200) })],
  });
  await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.equal(h.results[0].result.code, "REQUESTED_BY_INVALID");
  assert.equal(
    h.calls.some(
      (value) => value.startsWith("status:") || value.startsWith("run:"),
    ),
    false,
  );
});

test("RERUN/STOP/RELEASEを逐次childへ渡しrerun-fromも保持する", async () => {
  let releaseState = false;
  const records = [
    request({ id: "1", rerunFromNode: "node-b" }),
    request({ id: "2", requestType: "STOP" }),
    request({ id: "3", requestType: "RELEASE" }),
  ];
  const h = harness({
    requested: records,
    statusFor(network, runId) {
      if (network.networkId !== "net-a") return null;
      if (runId === "run-42" && releaseState)
        return status(
          run({
            status: "RUNNING",
            activity: "STOPPED",
            hold: {
              state: "REQUESTED",
              requested_by: "operator",
              requested_at: nowText,
            },
          }),
        );
      return status(
        run({
          status: "RUNNING",
          activity: runId === "run-42" ? undefined : "IDLE",
        }),
      );
    },
    cancelRun(_value, release) {
      if (!release) releaseState = true;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });
  await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.deepEqual(
    h.calls.filter((value) => /^(run|cancel):/.test(value)),
    ["run:1:net-a", "cancel:2:false", "cancel:3:true"],
  );
  assert.equal(records[0].rerunFromNode, "node-b");
});

test("heartbeat継続中の長時間childは完了までACCEPTEDを更新する", async () => {
  let finishChild;
  let clock = new Date(nowText);
  let lastHeartbeat;
  const childPromise = new Promise((resolve) => {
    finishChild = resolve;
  });
  const waits = [];
  const h = harness({ requested: [request()], runNetwork: () => childPromise });
  const originalHeartbeat = h.store.heartbeat;
  h.store.heartbeat = async (value, heartbeatAt) => {
    lastHeartbeat = await originalHeartbeat(value, heartbeatAt);
    return lastHeartbeat;
  };
  const polling = pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => clock,
    wait: () => new Promise((resolve) => waits.push(resolve)),
  });
  while (waits.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  clock = new Date("2026-08-31T02:10:00Z");
  waits.shift()();
  while (!h.calls.some((value) => value.startsWith("heartbeat:")))
    await new Promise((resolve) => setImmediate(resolve));

  const observer = harness({ acceptedRecords: [lastHeartbeat] });
  const observed = await pollRequests({
    store: observer.store,
    child: observer.child,
    config,
    host: "poller-observer",
    now: () => new Date("2026-08-31T02:26:00Z"),
  });
  assert.equal(observed.stale, 0);
  finishChild({
    output: {
      outcome: "RESUME",
      run_id: "run-42",
      invocation_id: "invoke-42",
      aggregate_status: "SUCCESS",
      invocation_result_code: "OK",
    },
    process: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  });
  const summary = await polling;
  assert.equal(summary.completed, 1);
  assert.equal(
    h.calls.filter((value) => value.startsWith("heartbeat:")).length,
    1,
  );
  assert.equal(h.results[0].result.state, "DONE");
});

test("親死亡相当の期限超過はLIVEなら保留、非LIVEならSTALEで自動再実行しない", async () => {
  const old = accepted(request({ claimHeartbeatAt: "2026-08-31T01:43:59Z" }));
  const liveRun = run({ status: "RUNNING", activity: "LIVE" });
  for (const [live, expectedStale] of [
    [true, 0],
    [false, 1],
  ]) {
    const h = harness({
      acceptedRecords: [old],
      statusFor(network) {
        return network.networkId === "net-a"
          ? status(live ? liveRun : run())
          : null;
      },
    });
    const summary = await pollRequests({
      store: h.store,
      child: h.child,
      config,
      host: "poller",
      now: () => new Date(nowText),
    });
    assert.equal(summary.stale, expectedStale);
    assert.equal(
      h.calls.some((value) => value.startsWith("run:")),
      false,
    );
    if (!live) assert.equal(h.results[0].result.code, "STALE");
  }
});

test("stale境界は15分+分精度60秒を超えた場合だけ回収する", async () => {
  for (const [heartbeat, expected] of [
    ["2026-08-31T01:44:00Z", 0],
    ["2026-08-31T01:43:59.999Z", 1],
  ]) {
    const h = harness({
      acceptedRecords: [accepted(request({ claimHeartbeatAt: heartbeat }))],
    });
    const summary = await pollRequests({
      store: h.store,
      child: h.child,
      config,
      host: "poller",
      now: () => new Date(nowText),
    });
    assert.equal(summary.stale, expected);
  }
});

test("claim競合はchild起動せず、同一process内の要求は逐次実行する", async () => {
  const first = request({ id: "1" });
  const second = request({ id: "2" });
  const h = harness({ requested: [first, second] });
  let active = 0;
  let maximum = 0;
  h.store.claim = async (value) => (value.id === "1" ? null : accepted(value));
  h.child.runNetwork = async (_network, value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    h.calls.push(`run:${value.id}`);
    return {
      output: {
        outcome: "RESUME",
        run_id: value.runId,
        invocation_id: `invoke-${value.id}`,
        aggregate_status: "SUCCESS",
        invocation_result_code: "OK",
      },
      process: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
  };
  await pollRequests({
    store: h.store,
    child: h.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.equal(maximum, 1);
  assert.deepEqual(
    h.calls.filter((value) => value.startsWith("run:")),
    ["run:2"],
  );

  const sequential = harness({ requested: [first, second] });
  active = 0;
  maximum = 0;
  sequential.child.runNetwork = async (_network, value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    sequential.calls.push(`run:${value.id}`);
    return {
      output: {
        outcome: "RESUME",
        run_id: value.runId,
        invocation_id: `invoke-${value.id}`,
        aggregate_status: "SUCCESS",
        invocation_result_code: "OK",
      },
      process: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
  };
  await pollRequests({
    store: sequential.store,
    child: sequential.child,
    config,
    host: "poller",
    now: () => new Date(nowText),
  });
  assert.equal(maximum, 1);
  assert.deepEqual(
    sequential.calls.filter((value) => value.startsWith("run:")),
    ["run:1", "run:2"],
  );
});
