import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const templatePath = resolve(
  "templates/console/set-joblog-field-acl.console.js",
);
const targetCodes = [
  "correlation_id",
  "attempt_id",
  "execution_id",
  "job_id",
  "runner_execution_started_at",
];
const everyoneRead = {
  accessibility: "READ",
  entity: { type: "GROUP", code: "everyone" },
};

async function evaluate({
  prompts = ["4281"],
  confirms = [true],
  fields = targetCodes,
  rights = [],
  liveRights,
} = {}) {
  const calls = [];
  const errors = [];
  const logs = [];
  const promptValues = [...prompts];
  const confirmValues = [...confirms];
  let putRights = null;
  const kintone = {
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url === "/k/v1/preview/app/form/fields.json" && method === "GET") {
        return {
          properties: Object.fromEntries(
            fields.map((code) => [code, { type: "SINGLE_LINE_TEXT", code }]),
          ),
        };
      }
      if (url === "/k/v1/preview/field/acl.json" && method === "GET") {
        return { rights, revision: "7" };
      }
      if (url === "/k/v1/preview/field/acl.json" && method === "PUT") {
        putRights = body.rights;
        return { revision: "8" };
      }
      if (url === "/k/v1/preview/app/deploy.json" && method === "GET") {
        return { apps: [{ status: "SUCCESS" }] };
      }
      if (url === "/k/v1/field/acl.json" && method === "GET") {
        return { rights: liveRights ?? putRights ?? rights };
      }
      return {};
    },
  };
  kintone.api.url = (endpoint, detectGuestSpace) => {
    assert.equal(detectGuestSpace, true, "kintone.api.urlは第2引数trueで呼ぶ");
    return endpoint;
  };
  await vm.runInNewContext(readFileSync(templatePath, "utf8"), {
    confirm: () => confirmValues.shift() ?? false,
    console: {
      error: (...values) => errors.push(values.join(" ")),
      log: (...values) => logs.push(values.join(" ")),
      warn() {},
    },
    kintone,
    prompt: () => promptValues.shift() ?? null,
    setTimeout: (callback) => callback(),
  });
  return { calls, errors, logs };
}

test("相関5フィールドをEveryone閲覧のみへ差し替え、他フィールドは保持してデプロイ・検証する", async () => {
  const other = {
    code: "rerun_request",
    entities: [
      { accessibility: "WRITE", entity: { type: "GROUP", code: "ops" } },
    ],
  };
  const stale = {
    code: "job_id",
    entities: [
      { accessibility: "WRITE", entity: { type: "GROUP", code: "everyone" } },
    ],
  };
  const { calls, errors, logs } = await evaluate({ rights: [other, stale] });
  assert.deepEqual(
    calls.map(({ url, method }) => `${method} ${url}`),
    [
      "GET /k/v1/preview/app/form/fields.json",
      "GET /k/v1/preview/field/acl.json",
      "PUT /k/v1/preview/field/acl.json",
      "POST /k/v1/preview/app/deploy.json",
      "GET /k/v1/preview/app/deploy.json",
      "GET /k/v1/field/acl.json",
    ],
  );
  const put = calls[2].body;
  assert.equal(put.app, "4281");
  assert.equal(put.revision, "7");
  const normalized = JSON.parse(JSON.stringify(put.rights));
  assert.deepEqual(normalized[0], other);
  assert.deepEqual(
    normalized.slice(1),
    targetCodes.map((code) => ({ code, entities: [everyoneRead] })),
  );
  assert.deepEqual(errors, []);
  assert.match(logs.join("\n"), /完了/u);
});

test("既にEveryone閲覧のみなら書込もデプロイもしない(冪等)", async () => {
  const { calls, errors } = await evaluate({
    rights: targetCodes.map((code) => ({ code, entities: [everyoneRead] })),
  });
  assert.equal(
    calls.some(({ method }) => method === "PUT" || method === "POST"),
    false,
  );
  assert.deepEqual(errors, []);
});

test("相関フィールドが無いアプリには何も変更せず中止する", async () => {
  const { calls, errors } = await evaluate({
    fields: ["correlation_id", "attempt_id"],
  });
  assert.equal(calls.length, 1);
  assert.match(
    errors.join("\n"),
    /execution_id, job_id, runner_execution_started_at/u,
  );
  assert.match(errors.join("\n"), /template v0\.4/u);
});

test("confirmで拒否するとpreviewへ書込しない", async () => {
  const { calls } = await evaluate({ confirms: [false] });
  assert.equal(
    calls.some(({ method }) => method === "PUT" || method === "POST"),
    false,
  );
});
