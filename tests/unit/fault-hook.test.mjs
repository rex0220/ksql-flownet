import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFaultFetch,
  matchesBarrier,
  readControl,
  waitForRelease,
} from "../e2e/fault-hook-core.mjs";

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "flownet-fault-hook-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return {
    controlFile: join(directory, "control.txt"),
    logFile: join(directory, "events.jsonl"),
    releaseFile: join(directory, "release"),
  };
}

function response(status = 200) {
  return { status, ok: status >= 200 && status < 300 };
}

test("旧制御形式pass/block/block-writesを維持する", async (context) => {
  const paths = await fixture(context);
  const calls = [];
  const fetch = createFaultFetch({
    originalFetch: async (input, init) => {
      calls.push({ input, init });
      return response();
    },
    ...paths,
    targetHost: "example.test",
  });

  await writeFile(paths.controlFile, "pass\n", "utf8");
  assert.equal(
    (await fetch("https://example.test/k/v1/record.json")).status,
    200,
  );

  await writeFile(paths.controlFile, "block\n", "utf8");
  await assert.rejects(
    fetch("https://example.test/k/v1/record.json"),
    /fetch failed/u,
  );

  await writeFile(paths.controlFile, "block-writes\n", "utf8");
  assert.equal(
    (await fetch("https://example.test/k/v1/record.json")).status,
    200,
  );
  await assert.rejects(
    fetch("https://example.test/k/v1/record.json", { method: "PUT" }),
    /fetch failed/u,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(readControl(paths.controlFile), {
    mode: "block-writes",
    barriers: [],
  });
});

test("barrier matchはpath/method/body app・field・idを組み合わせる", async (context) => {
  const { releaseFile } = await fixture(context);
  const barrier = {
    id: "b1",
    phase: "before",
    release: releaseFile,
    match: {
      path: "^/k/v1/record\\.json$",
      method: "PUT",
      body: { app: 123, field: "request_state", id: "9" },
    },
  };
  const matching = {
    path: "/k/v1/record.json",
    method: "PUT",
    body: {
      app: "123",
      id: 9,
      record: { request_state: { value: "ACCEPTED" } },
    },
  };
  assert.equal(matchesBarrier(barrier, matching), true);
  for (const changed of [
    { path: "/k/v1/records.json" },
    { method: "POST" },
    { body: { ...matching.body, app: 124 } },
    { body: { ...matching.body, id: 10 } },
    { body: { ...matching.body, record: {} } },
  ]) {
    assert.equal(matchesBarrier(barrier, { ...matching, ...changed }), false);
  }
});

async function barrierFetch(context, barrier, status = 200) {
  const paths = await fixture(context);
  const events = [];
  let calls = 0;
  await writeFile(
    paths.controlFile,
    JSON.stringify({
      mode: "pass",
      barriers: [{ ...barrier, release: paths.releaseFile }],
    }),
    "utf8",
  );
  const fetch = createFaultFetch({
    originalFetch: async () => {
      calls += 1;
      return response(status);
    },
    ...paths,
    targetHost: "example.test",
    appendLog: (event) => events.push(event),
  });
  return { ...paths, events, fetch, calls: () => calls };
}

test("before barrierは送信前に停止しrelease後に一度だけ進む", async (context) => {
  const h = await barrierFetch(context, {
    id: "before-1",
    phase: "before",
    match: { path: "record\\.json$", method: "PUT" },
  });
  const pending = h.fetch("https://example.test/k/v1/record.json", {
    method: "PUT",
  });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  assert.equal(h.calls(), 0);
  assert.equal(h.events.at(-1).barrier_id, "before-1");
  assert.equal(h.events.at(-1).response_status, undefined);
  assert.deepEqual(Object.keys(h.events.at(-1)).sort(), [
    "at",
    "barrier_id",
    "method",
    "path",
    "phase",
  ]);
  await writeFile(h.releaseFile, "release\n", "utf8");
  assert.equal((await pending).status, 200);
  await h.fetch("https://example.test/k/v1/record.json", { method: "PUT" });
  assert.equal(h.calls(), 2);
  assert.equal(
    h.events.filter(({ barrier_id: id }) => id === "before-1").length,
    1,
  );
});

test("after-success barrierは2xx応答後だけ停止する", async (context) => {
  const success = await barrierFetch(context, {
    id: "after-1",
    phase: "after-success",
    match: { path: "record\\.json$" },
  });
  const pending = success.fetch("https://example.test/k/v1/record.json");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  assert.equal(success.calls(), 1);
  assert.equal(success.events.at(-1).response_status, 200);
  assert.deepEqual(Object.keys(success.events.at(-1)).sort(), [
    "at",
    "barrier_id",
    "method",
    "path",
    "phase",
    "response_status",
  ]);
  await writeFile(success.releaseFile, "release\n", "utf8");
  assert.equal((await pending).status, 200);

  const failure = await barrierFetch(
    context,
    {
      id: "after-error",
      phase: "after-success",
      match: { path: "record\\.json$" },
    },
    409,
  );
  assert.equal(
    (await failure.fetch("https://example.test/k/v1/record.json")).status,
    409,
  );
  assert.equal(
    failure.events.some(({ barrier_id: id }) => id === "after-error"),
    false,
  );
});

test("複数barrierは独立に一度ずつ発火する", async (context) => {
  const paths = await fixture(context);
  const events = [];
  await writeFile(
    paths.controlFile,
    JSON.stringify({
      mode: "pass",
      barriers: [
        {
          id: "record-put",
          phase: "before",
          release: paths.releaseFile,
          match: { path: "record\\.json$", method: "PUT" },
        },
        {
          id: "records-get",
          phase: "after-success",
          release: paths.releaseFile,
          match: { path: "records\\.json$", method: "GET" },
        },
      ],
    }),
    "utf8",
  );
  const fetch = createFaultFetch({
    originalFetch: async () => response(),
    ...paths,
    targetHost: "example.test",
    appendLog: (event) => events.push(event),
    wait: async () => {},
  });
  for (let count = 0; count < 2; count += 1) {
    await fetch("https://example.test/k/v1/record.json", { method: "PUT" });
    await fetch("https://example.test/k/v1/records.json");
  }
  assert.deepEqual(
    events.filter(({ barrier_id: id }) => id).map(({ barrier_id: id }) => id),
    ["record-put", "records-get"],
  );
});

test("release待ちは100ms既定・120秒上限でタイムアウトする", async () => {
  let milliseconds = 0;
  const intervals = [];
  await assert.rejects(
    waitForRelease("C:\\missing-release", {
      fileExists: () => false,
      now: () => milliseconds,
      sleep: async (interval) => {
        intervals.push(interval);
        milliseconds += interval;
      },
    }),
    /timed out after 120000ms/u,
  );
  assert.ok(intervals.length > 0);
  assert.ok(intervals.every((value) => value === 100));
});
