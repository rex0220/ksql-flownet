import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeChild,
  FlownetChildClient,
  requestedBy,
} from "../../dist/requests/flownet-child-client.js";
import {
  classifyCancelResult,
  classifyRunNetworkResult,
  classifyStartNetworkResult,
} from "../../dist/requests/request-result.js";

function request(overrides = {}) {
  return {
    id: "42",
    creatorCode: "担当者+ops@example.test",
    runId: "run-42",
    rerunFromNode: "node-b",
    reason: "approved after investigation",
    ...overrides,
  };
}

const processResult = (overrides = {}) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

test("childはshell非経由argv配列でrerun-fromを渡しREQUESTED_BYだけ上書きする", async () => {
  const calls = [];
  const client = new FlownetChildClient({
    profile: "prod",
    cliPath: "C:\\app\\cli.js",
    environment: { KEEP_ME: "kept", KSQL_FLOWNET_REQUESTED_BY: "parent" },
    async execute(command, args, options) {
      calls.push({ command, args, options });
      return processResult({
        stdout: JSON.stringify({
          outcome: "RESUME",
          run_id: "run-42",
          invocation_id: "invoke-42",
          aggregate_status: "SUCCESS",
          invocation_result_code: "OK",
        }),
      });
    },
  });
  await client.runNetwork(
    { networkId: "net-a", definitionPath: "C:\\net.yaml" },
    request(),
  );
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args, [
    "C:\\app\\cli.js",
    "run-network",
    "C:\\net.yaml",
    "--resume-run",
    "run-42",
    "--rerun-from",
    "node-b",
    "--json",
  ]);
  assert.equal(calls[0].options.env.KEEP_ME, "kept");
  assert.equal(
    calls[0].options.env.KSQL_FLOWNET_REQUESTED_BY,
    requestedBy(request()),
  );
  assert.equal(
    requestedBy(request()),
    "app-request:42:%E6%8B%85%E5%BD%93%E8%80%85%2Bops%40example.test",
  );
});

test("status/cancel-run argvを固定しreason一時ファイルをfinallyで必ず削除する", async () => {
  let directory;
  let reasonPath;
  const calls = [];
  const client = new FlownetChildClient({
    profile: "prod",
    async makeTempDirectory() {
      directory = await mkdtemp(join(tmpdir(), "flownet-test-"));
      return directory;
    },
    async execute(_command, args, options) {
      calls.push({ args, options });
      if (args.includes("status")) {
        return processResult({
          stdout: JSON.stringify({
            network_id: "net-a",
            profile: "prod",
            lock: null,
            runs: [],
          }),
        });
      }
      reasonPath = args.at(-1);
      await access(reasonPath);
      throw new Error("simulated child failure");
    },
  });
  const network = { networkId: "net-a", definitionPath: "C:\\net.yaml" };
  await client.status(network, "run-42");
  await client.status(network, { businessKey: "net@2026-08" });
  await assert.rejects(
    client.cancelRun(request(), true),
    /simulated child failure/,
  );
  await assert.rejects(access(reasonPath));
  await assert.rejects(access(directory));
  assert.deepEqual(calls[0].args.slice(1), [
    "status",
    "net-a",
    "--profile",
    "prod",
    "--run-id",
    "run-42",
    "--json",
  ]);
  assert.deepEqual(calls[1].args.slice(1), [
    "status",
    "net-a",
    "--profile",
    "prod",
    "--business-key",
    "net@2026-08",
    "--json",
  ]);
  assert.deepEqual(calls[2].args.slice(1, -1), [
    "cancel-run",
    "--run-id",
    "run-42",
    "--release",
    "--reason-file",
  ]);
});

test("archive-runはdefinition path・run id・reason fileとREQUESTED_BYを渡して一時ファイルを削除する", async () => {
  let directory;
  let reasonPath;
  const calls = [];
  const client = new FlownetChildClient({
    profile: "prod",
    cliPath: "C:\\app\\cli.js",
    async makeTempDirectory() {
      directory = await mkdtemp(join(tmpdir(), "flownet-archive-test-"));
      return directory;
    },
    async execute(command, args, options) {
      calls.push({ command, args, options });
      reasonPath = args.at(-1);
      await access(reasonPath);
      return processResult({
        stdout: JSON.stringify({
          outcome: "ARCHIVED",
          run_id: "run-42",
          event_id: "archive-event-42",
          run_revision: 8,
          audit: "RECORDED",
          lock_released: true,
        }),
      });
    },
  });
  const actual = await client.archiveRun(
    { networkId: "net-a", definitionPath: "C:\\net.yaml" },
    request(),
  );
  assert.equal(actual.output.outcome, "ARCHIVED");
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(0, -1), [
    "C:\\app\\cli.js",
    "archive-run",
    "C:\\net.yaml",
    "--run-id",
    "run-42",
    "--reason-file",
  ]);
  assert.equal(
    calls[0].options.env.KSQL_FLOWNET_REQUESTED_BY,
    requestedBy(request()),
  );
  await assert.rejects(access(reasonPath));
  await assert.rejects(access(directory));
});

test("STARTの3入力modeは完全一致argvを使いresume系を一切持たない", async () => {
  const calls = [];
  const client = new FlownetChildClient({
    profile: "prod",
    cliPath: "C:\\app\\cli.js",
    async execute(_command, args, options) {
      calls.push({ args, options });
      return processResult({
        stdout: JSON.stringify({
          outcome: "NEW",
          run_id: "run-new",
          invocation_id: "invoke-new",
          aggregate_status: "SUCCESS",
          invocation_result_code: "OK",
          blocked_run_ids: [],
        }),
      });
    },
  });
  const network = { networkId: "net-a", definitionPath: "C:\\net.yaml" };
  const value = request();
  await client.startNetwork(network, value, { businessKey: "manual" });
  await client.startNetwork(network, value, {
    scheduledFor: "2026-08-01T00:00:00.000Z",
  });
  await client.startNetwork(network, value, {
    businessKey: "correction",
    scheduledFor: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      [
        "C:\\app\\cli.js",
        "run-network",
        "C:\\net.yaml",
        "--business-key",
        "manual",
        "--json",
      ],
      [
        "C:\\app\\cli.js",
        "run-network",
        "C:\\net.yaml",
        "--scheduled-for",
        "2026-08-01T00:00:00.000Z",
        "--json",
      ],
      [
        "C:\\app\\cli.js",
        "run-network",
        "C:\\net.yaml",
        "--business-key",
        "correction",
        "--scheduled-for",
        "2026-08-01T00:00:00.000Z",
        "--json",
      ],
    ],
  );
  for (const { args, options } of calls) {
    assert.equal(args.includes("--resume"), false);
    assert.equal(args.includes("--resume-run"), false);
    assert.equal(args.includes("--rerun-from"), false);
    assert.equal(options.shell, false);
  }
});

test("stdout/stderrはbyte上限で切り詰め、shellを使わない", async () => {
  const result = await executeChild(
    process.execPath,
    [
      "-e",
      "process.stdout.write('a'.repeat(100));process.stderr.write('b'.repeat(100))",
    ],
    { env: process.env, shell: false },
    16,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.byteLength(result.stdout), 16);
  assert.equal(Buffer.byteLength(result.stderr), 16);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("Invocation作成後のretry brakeノードはDONE/RETRY_BRAKE、作成前はREJECTED", () => {
  const done = classifyRunNetworkResult({
    output: {
      outcome: "RESUME",
      run_id: "run-42",
      invocation_id: "invoke-42",
      aggregate_status: "FAILED",
      invocation_result_code: "NODE_FAILED_OR_BLOCKED",
      retry_brake_node_ids: ["node-a", "node-b"],
    },
    process: processResult({ exitCode: 1 }),
  });
  assert.deepEqual(done, {
    state: "DONE",
    code: "RETRY_BRAKE",
    message:
      "aggregate=FAILED; invocation_id=invoke-42; retry_brake_node_ids=node-a,node-b",
  });
  const rejected = classifyRunNetworkResult({
    output: {
      outcome: "REJECTED",
      run_id: "run-42",
      invocation_id: null,
      aggregate_status: null,
      invocation_result_code: "LOCK_CONFLICT",
    },
    process: processResult({ exitCode: 1, stderr: "token=must-not-leak" }),
  });
  assert.equal(rejected.state, "REJECTED");
  assert.equal(rejected.code, "LOCK_CONFLICT");
  assert.doesNotMatch(rejected.message, /must-not-leak|token/u);
  assert.equal(
    classifyCancelResult(
      processResult({ stderr: "SECRET_VALUE" }),
      false,
    ).message.includes("SECRET_VALUE"),
    false,
  );
});

test("retry brakeノードが空またはフィールド欠落ならInvocation result codeを維持する", () => {
  for (const output of [
    {
      outcome: "RESUME",
      run_id: "run-42",
      invocation_id: "invoke-42",
      aggregate_status: "FAILED",
      invocation_result_code: "NODE_FAILED_OR_BLOCKED",
      retry_brake_node_ids: [],
    },
    {
      outcome: "RESUME",
      run_id: "run-42",
      invocation_id: "invoke-42",
      aggregate_status: "FAILED",
      invocation_result_code: "NODE_FAILED_OR_BLOCKED",
    },
  ]) {
    assert.deepEqual(
      classifyRunNetworkResult({
        output,
        process: processResult({ exitCode: 1 }),
      }),
      {
        state: "DONE",
        code: "NODE_FAILED_OR_BLOCKED",
        message: "aggregate=FAILED; invocation_id=invoke-42",
      },
    );
  }
});

test("NOOPはInvocationなしでもDONEに分類する", () => {
  assert.equal(
    classifyRunNetworkResult({
      output: {
        outcome: "NOOP",
        run_id: "run-42",
        invocation_id: null,
        aggregate_status: "SUCCESS",
        invocation_result_code: "NOOP_ALREADY_SUCCESS",
      },
      process: processResult(),
    }).state,
    "DONE",
  );
});

test("START classifierは旧JSONのblocked_run_ids欠落を安全に扱う", () => {
  const result = classifyStartNetworkResult({
    output: {
      outcome: "REJECTED",
      run_id: null,
      invocation_id: null,
      aggregate_status: null,
      invocation_result_code: "RUN_ALREADY_EXISTS",
    },
    process: processResult({ exitCode: 1 }),
  });
  assert.equal(result.code, "RUN_ALREADY_EXISTS");
  assert.match(result.message, /RERUN/u);
});
