import assert from "node:assert/strict";

import { RepositoryError } from "../../dist/persistence/repository.js";
import {
  createObservedFetch,
  createRepository,
  assertObserved,
  getRecords,
  makeRun,
  runIntegration,
  summarizeError,
  uploadBundle,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-run-uniqueness",
  async ({ config, scope }) => {
    const observations = [];
    const repository = createRepository(
      config,
      createObservedFetch(observations),
    );
    const bundle = await uploadBundle(config, scope);
    const shared = {
      network_id: `${scope}_network`,
      business_key: `${scope}_business`,
      resolved_profile_snapshot: {
        ...makeRun(scope, bundle).resolved_profile_snapshot,
        profile: `${scope}_profile`,
      },
    };
    const candidates = [
      makeRun(`${scope}_a`, bundle, shared),
      makeRun(`${scope}_b`, bundle, shared),
    ];
    const outcomes = await Promise.allSettled(
      candidates.map((candidate) => repository.createRun(candidate)),
    );
    const fulfilled = outcomes.filter(({ status }) => status === "fulfilled");
    const rejected = outcomes.filter(({ status }) => status === "rejected");
    const persisted = (
      await getRecords(
        config,
        "state",
        `record_type in ("NETWORK_RUN") and network_id in ("${shared.network_id}") and business_key in ("${shared.business_key}")`,
      )
    ).filter((record) => {
      const snapshot = JSON.parse(
        String(record.resolved_profile_snapshot.value),
      );
      return snapshot.profile === `${scope}_profile`;
    });
    assert.equal(
      fulfilled.length,
      1,
      "同一business keyのcreateRun成功は1件でなければなりません",
    );
    assert.equal(
      rejected.length,
      1,
      "2件目のcreateRunはfail-closedでなければなりません",
    );
    assertObserved(
      rejected[0]?.reason instanceof RepositoryError &&
        rejected[0].reason.code === "DUPLICATE_RECORD",
      { name: "RepositoryError", code: "DUPLICATE_RECORD" },
      summarizeError(rejected[0]?.reason),
      "2件目はDUPLICATE_RECORDへ裁定されなければなりません",
    );
    assertObserved(
      observations.some(
        ({ status, apiCode }) => status === 400 && apiCode === "CB_VA01",
      ),
      { status: 400, apiCode: "CB_VA01" },
      observations,
      "kintoneのCB_VA01最終裁定を観測できませんでした",
    );
    assert.equal(
      persisted.length,
      1,
      "永続Network Runは1件でなければなりません",
    );
    return {
      outcomes: outcomes.map((outcome) =>
        outcome.status === "fulfilled"
          ? { status: "fulfilled", runId: outcome.value.value.run_id }
          : { status: "rejected", error: summarizeError(outcome.reason) },
      ),
      persistedRunIds: persisted.map((record) => record.run_id.value),
      observations,
    };
  },
);
