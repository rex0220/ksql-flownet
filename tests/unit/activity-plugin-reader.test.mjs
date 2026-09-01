import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkInConditions,
  readAllByChunks,
  readAllByKeyset,
} from "../../dist/plugin/kintone-reader.js";

const field = (value) => ({ value });
const record = (id) => ({ $id: field(String(id)), value: field(`v${id}`) });

test("$id keyset paging handles exactly 500 records and 501 records", async () => {
  for (const total of [500, 501]) {
    const source = Array.from({ length: total }, (_, index) =>
      record(index + 1),
    );
    const requests = [];
    const fetchRecords = async (request) => {
      requests.push(request);
      const match = request.query.match(/\$id > ([0-9]+)/u);
      const lastId = match === null ? 0 : Number(match[1]);
      return { records: source.slice(lastId, lastId + 500) };
    };
    const result = await readAllByKeyset(fetchRecords, {
      app: "state-app",
      baseQuery: 'record_type in ("NETWORK_RUN")',
      fields: ["run_id"],
    });
    assert.equal(result.length, total);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].fields, ["run_id", "$id"]);
    assert.equal(
      requests[0].query,
      'record_type in ("NETWORK_RUN") order by $id asc limit 500',
    );
    assert.match(requests[1].query, /\$id > 500/u);
  }
});

test("ID values are chunked by count and escaped query length", async () => {
  assert.deepEqual(
    chunkInConditions("invocation_id", ['a"b', "c\\d", "e"], {
      maxValues: 2,
      maxQueryLength: 100,
    }),
    ['invocation_id in ("a\\"b", "c\\\\d")', 'invocation_id in ("e")'],
  );
  assert.equal(
    chunkInConditions("run_id", ["aaaa", "bbbb"], {
      maxValues: 10,
      maxQueryLength: 20,
    }).length,
    2,
  );

  const queries = [];
  const result = await readAllByChunks(
    async (request) => {
      queries.push(request.query);
      return { records: [record(queries.length)] };
    },
    {
      app: "audit-app",
      baseQuery: 'record_type in ("RUN_INVOCATION")',
      field: "invocation_id",
      values: ["one", "two", "three"],
      fields: ["invocation_id", "run_id"],
      maxValues: 2,
    },
  );
  assert.equal(result.length, 2);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /invocation_id in \("one", "two"\)/u);
  assert.match(queries[1], /invocation_id in \("three"\)/u);
});

test("non-monotonic pages and intermediate GET failures reject partial data", async () => {
  await assert.rejects(
    readAllByKeyset(async () => ({ records: [record(2), record(1)] }), {
      app: 1,
      baseQuery: "",
      fields: [],
    }),
    /strictly increasing/u,
  );

  let calls = 0;
  await assert.rejects(
    readAllByKeyset(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error("injected GET failure");
        return {
          records: Array.from({ length: 500 }, (_, index) => record(index + 1)),
        };
      },
      { app: 1, baseQuery: "", fields: [] },
    ),
    /injected GET failure/u,
  );
  assert.equal(calls, 2);
});
