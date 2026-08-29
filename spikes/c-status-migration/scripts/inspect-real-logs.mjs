import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import { isMain, writeResult } from "../../lib/runtime.mjs";

const FIELD_ALIASES = Object.freeze({
  current_status: ["current_status", "status"],
  record_type: ["record_type", "log_type"],
  log_detail: ["log_detail"],
  timeout_source: ["timeout_source", "timeout_type"],
  actor: ["actor", "updated_by", "created_by"],
});

function requireReadEnvironment(environment) {
  const names = [
    "KSQL_SPIKE_BASE_URL",
    "KSQL_SPIKE_APP_LOGS",
    "KSQL_TOKEN_LOGS_RO",
  ];
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`必要な環境変数がありません: ${missing.join(", ")}`);
  }
  let baseUrl;
  try {
    baseUrl = new URL(environment.KSQL_SPIKE_BASE_URL.trim());
  } catch {
    throw new Error("KSQL_SPIKE_BASE_URL が有効なURLではありません。");
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error("KSQL_SPIKE_BASE_URL は https URLで指定してください。");
  }
  const app = environment.KSQL_SPIKE_APP_LOGS.trim();
  if (!/^\d+$/.test(app)) {
    throw new Error("KSQL_SPIKE_APP_LOGS は数字のアプリIDで指定してください。");
  }
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    app,
    token: environment.KSQL_TOKEN_LOGS_RO,
  };
}

/**
 * Minimal reader: the returned object exposes GET operations only and never
 * accepts a method or request body from its caller.
 */
export function createReadOnlyLogsClient(config, fetchImplementation = fetch) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("Node.js組込みfetchが利用できません。");
  }
  let apiCalls = 0;

  async function getRecords({ limit, offset }) {
    const url = new URL("/k/v1/records.json", `${config.baseUrl}/`);
    url.searchParams.set("app", config.app);
    url.searchParams.set(
      "query",
      `order by $id asc limit ${limit} offset ${offset}`,
    );
    apiCalls += 1;
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: { "X-Cybozu-API-Token": config.token },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        `kintone read API GET ${url.pathname} が HTTP ${response.status} を返しました。`,
      );
    }
    if (!Array.isArray(body.records)) {
      throw new Error(
        "kintone read API response に records 配列がありません。",
      );
    }
    return body.records;
  }

  return Object.freeze({
    getOneRecord: () => getRecords({ limit: 1, offset: 0 }),
    getRecords: (limit) => getRecords({ limit, offset: 0 }),
    get apiCalls() {
      return apiCalls;
    },
  });
}

function fieldInventory(record) {
  return Object.entries(record)
    .map(([fieldName, cell]) => ({
      field_name: fieldName,
      field_type:
        cell && typeof cell === "object" && typeof cell.type === "string"
          ? cell.type
          : "UNKNOWN",
    }))
    .sort((left, right) => left.field_name.localeCompare(right.field_name));
}

function candidatesFor(fieldNames, aliases) {
  const lowerNames = new Map(
    fieldNames.map((fieldName) => [fieldName.toLowerCase(), fieldName]),
  );
  return aliases
    .map((alias) => lowerNames.get(alias))
    .filter((fieldName) => fieldName !== undefined);
}

function inspectConcept(concept, fields, records) {
  const candidates = candidatesFor(
    fields.map(({ field_name: fieldName }) => fieldName),
    FIELD_ALIASES[concept],
  );
  return {
    fixture_field_name: concept,
    actual_field_candidates: candidates,
    candidate_field_types: fields
      .filter(({ field_name: fieldName }) => candidates.includes(fieldName))
      .map(({ field_name: fieldName, field_type: fieldType }) => ({
        field_name: fieldName,
        field_type: fieldType,
      })),
    records_with_candidate: records.filter((record) =>
      candidates.some((fieldName) => record[fieldName]?.value != null),
    ).length,
    difference:
      candidates.length === 1 && candidates[0] === concept
        ? "none"
        : candidates.length === 0
          ? "field_not_found"
          : candidates.length === 1
            ? "field_name_differs"
            : "ambiguous_candidates",
  };
}

function statusDistribution(records, statusFieldCandidates) {
  if (statusFieldCandidates.length !== 1) return {};
  const fieldName = statusFieldCandidates[0];
  const counts = new Map();
  for (const record of records) {
    const value = record[fieldName]?.value;
    if (typeof value !== "string" || value.length === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function fixtureStatuses() {
  const fixtureUrl = new URL("../fixtures.yaml", import.meta.url);
  const fixture = parse(await readFile(fixtureUrl, "utf8"));
  return [
    ...new Set(fixture.cases.map(({ input }) => input.current_status)),
  ].sort();
}

export async function inspectRealLogs(client, sampleSize) {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 500) {
    throw new Error("sampleSize は1以上500以下の整数で指定してください。");
  }

  // Field discovery must precede aggregation. No field name is guessed before
  // this one-record read has completed.
  const firstRecords = await client.getOneRecord();
  const firstRecord = firstRecords[0];
  const records = firstRecord ? await client.getRecords(sampleSize) : [];
  const fields = firstRecord ? fieldInventory(firstRecord) : [];
  const concepts = Object.fromEntries(
    Object.keys(FIELD_ALIASES).map((concept) => [
      concept,
      inspectConcept(concept, fields, records),
    ]),
  );
  const distribution = statusDistribution(
    records,
    concepts.current_status.actual_field_candidates,
  );
  const observedStatuses = Object.keys(distribution);
  const expectedStatuses = await fixtureStatuses();

  return {
    mode: "read_only",
    sample: {
      requested_records: sampleSize,
      sampled_records: records.length,
      discovery_records: firstRecords.length,
      read_api_calls: client.apiCalls,
    },
    discovered_fields: fields,
    status: {
      selected_field:
        concepts.current_status.actual_field_candidates.length === 1
          ? concepts.current_status.actual_field_candidates[0]
          : null,
      distribution,
      fixture_statuses_not_observed: expectedStatuses.filter(
        (status) => !observedStatuses.includes(status),
      ),
      observed_statuses_not_in_fixture: observedStatuses.filter(
        (status) => !expectedStatuses.includes(status),
      ),
    },
    fixture_input_comparison: concepts,
  };
}

function sampleSizeFromArguments(arguments_) {
  const index = arguments_.indexOf("--sample-size");
  if (index === -1) return 500;
  const value = Number(arguments_[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error("--sample-size は1以上500以下の整数で指定してください。");
  }
  return value;
}

export async function runInspectRealLogs({
  environment = process.env,
  arguments_ = process.argv.slice(2),
  fetchImplementation = fetch,
} = {}) {
  const config = requireReadEnvironment(environment);
  const client = createReadOnlyLogsClient(config, fetchImplementation);
  const report = await inspectRealLogs(
    client,
    sampleSizeFromArguments(arguments_),
  );
  const path = await writeResult(import.meta.url, report, [config.token]);
  console.log(`read-only inspection result: ${path}`);
  return { path, report };
}

if (isMain(import.meta.url)) {
  await runInspectRealLogs();
}
