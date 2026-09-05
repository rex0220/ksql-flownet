import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequest,
  decodeRequest,
  P2_01_PREFIX,
} from "../e2e/p2-01-support.mjs";
import {
  assertStartCorrelation,
  startInput,
  TERMINAL_REQUEST_STATES,
} from "../e2e/p2-11-support.mjs";
import {
  buildFaultControl,
  extractRunArchivedAuditFields,
} from "../e2e/p2-16-support.mjs";

const field = (value) => ({ value });

test("request decoderは取消チェックをboolean化しフィールド不在をnullにする", () => {
  assert.equal(decodeRequest({}).cancelRequested, null);
  assert.equal(
    decodeRequest({ cancel_requested: field(["取消"]) }).cancelRequested,
    true,
  );
  assert.equal(
    decodeRequest({ cancel_requested: field([]) }).cancelRequested,
    false,
  );
});

test("createRequestはcancelRequested=trueのときだけ取消フィールドを送る", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const posts = [];
  globalThis.fetch = async (_url, init) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ id: "1" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        record: {
          $id: field("1"),
          $revision: field("1"),
          reason: field(`${P2_01_PREFIX}unit`),
          cancel_requested: field(["取消"]),
        },
      }),
    };
  };
  const settings = {
    baseUrl: "https://example.test",
    requestAppId: 123,
    requestApiToken: "write",
    requestReadToken: "read",
  };
  const created = await createRequest(settings, {
    requestType: "START",
    networkId: `${P2_01_PREFIX}network`,
    businessKey: `${P2_01_PREFIX}business`,
    reason: `${P2_01_PREFIX}unit`,
    cancelRequested: true,
  });
  assert.deepEqual(posts[0].record.cancel_requested, { value: ["取消"] });
  assert.equal(created.cancelRequested, true);
});

test("P2-11 terminal集合とSTART入力はCANCELLED/取消を扱う", () => {
  assert.deepEqual(
    [...TERMINAL_REQUEST_STATES],
    ["DONE", "REJECTED", "CANCELLED"],
  );
  assert.equal(
    startInput(`${P2_01_PREFIX}scope`, "cancel", {
      networkId: `${P2_01_PREFIX}network`,
      businessKey: "business",
      cancelRequested: true,
    }).cancelRequested,
    true,
  );
});

test("CANCELLED START相関はInvocationなしを正常な終端として検証する", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [] }),
  });
  const result = await assertStartCorrelation(
    {
      baseUrl: "https://example.test",
      auditAppId: 456,
      auditApiToken: "audit",
    },
    {
      id: "9",
      creatorCode: "operator@example.test",
      requestState: "CANCELLED",
    },
    "unused-business-key",
  );
  assert.equal(result.graph, null);
  assert.equal(
    result.expectedRequestedBy,
    "app-request:9:operator%40example.test",
  );
});

test("P2-16 fault制御JSONは対象app/record/fieldとphase/releaseを固定する", () => {
  const control = buildFaultControl({
    barrierId: `${P2_01_PREFIX}claim-before`,
    app: 123,
    recordId: "456",
    field: "claimed_at",
    phase: "before",
    release: "C:\\tmp\\claim-before.release",
  });
  assert.deepEqual(control, {
    mode: "pass",
    barriers: [
      {
        id: `${P2_01_PREFIX}claim-before`,
        match: {
          path: "^/k/v1/record\\.json$",
          method: "PUT",
          body: { app: 123, field: "claimed_at", id: "456" },
        },
        phase: "before",
        release: "C:\\tmp\\claim-before.release",
      },
    ],
  });
});

test("P2-16 RUN_ARCHIVED監査JSONから契約上の5項目だけを抽出する", () => {
  const extracted = extractRunArchivedAuditFields(
    JSON.stringify({
      event_id: "archive_123",
      event_type: "RUN_ARCHIVED",
      run_id: "run_1",
      result_code: "RUN_ARCHIVED",
      requested_by: `${P2_01_PREFIX}operator`,
      reason: `${P2_01_PREFIX}unit:archive`,
      archived_at: "2026-09-05T12:34:56.000Z",
      previous_status: "FAILED",
      run_revision_before: 7,
      service_principal: `${P2_01_PREFIX}service`,
    }),
  );
  assert.deepEqual(extracted, {
    requested_by: `${P2_01_PREFIX}operator`,
    reason: `${P2_01_PREFIX}unit:archive`,
    archived_at: "2026-09-05T12:34:56.000Z",
    previous_status: "FAILED",
    run_revision_before: 7,
  });
});
