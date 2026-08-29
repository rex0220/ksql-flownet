import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { URL } from "node:url";

import { releaseWhenReady } from "../../spikes/lib/barrier.mjs";
import {
  recordChildError,
  safeChildDisconnect,
  safeChildSend,
} from "../../spikes/lib/child-ipc.mjs";
import {
  createKintoneClient,
  field,
  insertRecord,
  updateRecord,
} from "../../spikes/lib/kintone.mjs";
import {
  requireExecutionEnvironment,
  sanitize,
} from "../../spikes/lib/runtime.mjs";
import { createStoreZip, readStoreZip } from "../../spikes/lib/zip-store.mjs";
import {
  attachBundle,
  downloadFile,
  getAttachedBundleFileKey,
  makeBundleRecordIdentity,
  sha256,
} from "../../spikes/b-bundle/scripts/bundle-support.mjs";

test("store-only ZIP writer/readerがbyte列とCRCを往復検証する", () => {
  const data = Buffer.from("kSQL-FlowNet bundle\n", "utf8");
  const zip = createStoreZip([{ name: "bundle.txt", data }]);
  const entries = readStoreZip(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "bundle.txt");
  assert.deepEqual(entries[0].data, data);

  const corrupted = Buffer.from(zip);
  corrupted[corrupted.indexOf(data) + 1] ^= 1;
  assert.throws(() => readStoreZip(corrupted), /CRC/);
});

test("SHA-256がNode.js標準実装の既知値と一致する", () => {
  const data = Buffer.from("abc");
  assert.equal(
    sha256(data),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(sha256(data), createHash("sha256").update(data).digest("hex"));
});

test("barrierは全workerのready後にだけ一斉startする", async () => {
  class Worker extends EventEmitter {
    sent = [];
    send(message) {
      this.sent.push(message);
    }
  }
  const workers = [new Worker(), new Worker(), new Worker()];
  const released = releaseWhenReady(workers, { type: "start", key: "same" });
  workers[0].emit("message", { type: "ready" });
  workers[1].emit("message", { type: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    workers.map((worker) => worker.sent),
    [[], [], []],
  );
  workers[2].emit("message", { type: "ready" });
  await released;
  assert.deepEqual(
    workers.map((worker) => worker.sent),
    Array.from({ length: 3 }, () => [{ type: "start", key: "same" }]),
  );
});

test("child IPC guardはclosed channelへの送信と切断を安全に無視する", () => {
  class Child extends EventEmitter {
    connected = true;
    send() {
      const error = new Error("write EPIPE");
      error.code = "EPIPE";
      throw error;
    }
    disconnect() {
      const error = new Error("channel closed");
      error.code = "ERR_IPC_CHANNEL_CLOSED";
      throw error;
    }
  }
  const child = new Child();
  const errors = [];
  const recordError = (error) => recordChildError(errors, error);
  child.on("error", recordError);

  assert.equal(safeChildSend(child, { type: "stop" }, recordError), false);
  assert.equal(safeChildDisconnect(child, recordError), false);
  child.emit(
    "error",
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  );
  child.emit("error", Object.assign(new Error("unexpected"), { code: "EIO" }));
  assert.deepEqual(
    errors.map((error) => error.code),
    ["EIO"],
  );

  child.connected = false;
  assert.equal(safeChildSend(child, { type: "stop" }, recordError), false);
  assert.equal(safeChildDisconnect(child, recordError), false);
});

test("結果payloadからtoken・Authorizationと秘密値を除去する", () => {
  const secret = "do-not-store-this-token";
  const safe = sanitize(
    {
      payload: {
        Authorization: `Bearer ${secret}`,
        apiToken: secret,
        nested: `prefix:${secret}:suffix`,
        ordinary: "kept",
      },
    },
    [secret],
  );
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(secret), false);
  assert.equal(/authorization|token/i.test(serialized), false);
  assert.equal(safe.payload.ordinary, "kept");
});

test("kintone clientは組込みfetch相当へtoken headerとJSON payloadを渡す", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: "101", revision: "1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createKintoneClient(
    {
      baseUrl: "https://example.cybozu.com",
      app: "9999",
      token: "mock-secret",
    },
    fetchMock,
  );
  const response = await insertRecord(client, "9999", {
    record_key: field("key-1"),
  });
  assert.deepEqual(response, { id: "101", revision: "1" });
  assert.equal(calls[0].url, "https://example.cybozu.com/k/v1/record.json");
  assert.equal(calls[0].options.headers["X-Cybozu-API-Token"], "mock-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    app: "9999",
    record: { record_key: { value: "key-1" } },
  });
  assert.equal(client.apiCalls, 1);
});

test("一意キーフィールドは64文字を許可し65文字をAPI呼出前に拒否する", async () => {
  let fetchCalls = 0;
  const client = createKintoneClient(
    {
      baseUrl: "https://example.cybozu.com",
      app: "9999",
      token: "mock-secret",
    },
    async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ id: "101", revision: "1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  await insertRecord(client, "9999", { record_key: field("a".repeat(64)) });
  assert.equal(fetchCalls, 1);
  await assert.rejects(
    insertRecord(client, "9999", { record_key: field("a".repeat(65)) }),
    /一意キーフィールド record_key は64文字以内.*現在65文字/,
  );
  await assert.rejects(
    insertRecord(client, "9999", {
      record_key: field("spike-d-lock:within-limit"),
      lock_key: field("d".repeat(65)),
    }),
    /一意キーフィールド lock_key は64文字以内.*現在65文字/,
  );
  await assert.rejects(
    updateRecord(client, "9999", "101", "1", {
      record_key: field("u".repeat(65)),
    }),
    /一意キーフィールド record_key は64文字以内.*現在65文字/,
  );
  assert.equal(fetchCalls, 1);
});

test("Spike Bの全ラベルでrun_idとrecord_keyが64文字以内になる", () => {
  const uuid = "12345678-1234-4567-89ab-123456789abc";
  for (const label of ["small", "medium", "limit-candidate", "corruption"]) {
    const identity = makeBundleRecordIdentity(label, uuid);
    assert.ok(identity.runId.length <= 64);
    assert.ok(identity.recordKey.length <= 64);
    assert.match(identity.runId, /-123456781234456789ab$/);
  }
});

test("添付後のレコードGETで得た新しいfileKeyをダウンロードに使う", async () => {
  const calls = [];
  const downloadedBytes = Buffer.from("attached bundle");
  const fetchMock = async (url, options) => {
    const requestUrl = new URL(url);
    calls.push({ url: requestUrl, options });
    if (options.method === "POST") {
      return Response.json({ id: "101", revision: "1" });
    }
    if (requestUrl.pathname.endsWith("/records.json")) {
      return Response.json({
        records: [
          {
            source_bundle_attachment: {
              value: [{ fileKey: "download-file-key" }],
            },
          },
        ],
      });
    }
    return new Response(downloadedBytes);
  };
  const client = createKintoneClient(
    {
      baseUrl: "https://example.cybozu.com",
      app: "9999",
      token: "mock-secret",
    },
    fetchMock,
  );

  const attached = await attachBundle(
    client,
    "9999",
    "upload-file-key",
    "expected-hash",
    "small",
  );
  const downloadFileKey = await getAttachedBundleFileKey(
    client,
    "9999",
    attached.recordKey,
  );
  const downloaded = await downloadFile(client, downloadFileKey);

  assert.equal(downloadFileKey, "download-file-key");
  assert.deepEqual(downloaded, downloadedBytes);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url.pathname, "/k/v1/records.json");
  assert.match(calls[1].url.searchParams.get("query"), /^record_key = /);
  assert.equal(calls[2].url.pathname, "/k/v1/file.json");
  assert.equal(calls[2].url.searchParams.get("fileKey"), "download-file-key");
});

test("既知の既存アプリIDを起動時検証で拒否する", () => {
  assert.throws(
    () =>
      requireExecutionEnvironment({
        KSQL_SPIKE_BASE_URL: "https://example.cybozu.com",
        KSQL_SPIKE_APP_EXEC: "4249",
        KSQL_SPIKE_TOKEN_EXEC: "secret",
      }),
    /既存アプリID 4249/,
  );
});
