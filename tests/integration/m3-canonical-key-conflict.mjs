import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import {
  attemptKey,
  nodeStateKey,
  runKey,
} from "../../dist/domain/canonical-record-key.js";
import {
  jobLockKey,
  networkLockKey,
} from "../../dist/domain/canonical-lock-key.js";
import { RepositoryError } from "../../dist/persistence/repository.js";
import {
  assertObserved,
  createObservedFetch,
  createRepository,
  getRecords,
  makeState,
  runIntegration,
  summarizeError,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-canonical-key-conflict",
  async ({ config, scope }) => {
    const recordVectors = JSON.parse(
      await readFile(
        new URL(
          "../fixtures/canonical-record-key/vectors.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const lockVectors = JSON.parse(
      await readFile(
        new URL("../fixtures/canonical-lock-key/vectors.json", import.meta.url),
        "utf8",
      ),
    );
    const recordChecks = recordVectors.valid.map((vector) => {
      const actual =
        vector.kind === "run"
          ? runKey(vector.profile, vector.network_id, vector.business_key)
          : vector.kind === "state"
            ? nodeStateKey(vector.run_id, vector.node_id)
            : attemptKey(vector.run_id, vector.node_id, vector.attempt_no);
      assert.equal(actual, vector.expected_key, vector.id);
      return { id: vector.id, actual };
    });
    const lockChecks = lockVectors.valid.map((vector) => {
      const actual =
        vector.kind === "network"
          ? networkLockKey(vector.profile, vector.identifier)
          : jobLockKey(vector.profile, vector.identifier);
      assert.equal(actual, vector.expected_key, vector.id);
      return { id: vector.id, actual };
    });

    const observations = [];
    const repository = createRepository(
      config,
      createObservedFetch(observations),
    );
    const nodeId = `${scope}_node`;
    const canonical = nodeStateKey(scope, nodeId);
    const base = makeState(scope, canonical, { node_id: nodeId });
    const inserts = await Promise.allSettled([
      repository.upsertNodeState({ value: base, expected_revision: null }),
      repository.upsertNodeState({
        value: { ...base, node_state_id: `${scope}_state_competitor` },
        expected_revision: null,
      }),
    ]);
    const stored = await getRecords(
      config,
      "state",
      `record_type in ("NODE_STATE") and node_state_key in ("${canonical}")`,
    );
    assert.equal(stored.length, 1, "同一node_state_keyが複数永続化されました");
    assertObserved(
      observations.some(
        ({ status, apiCode }) => status === 400 && apiCode === "CB_VA01",
      ),
      { status: 400, apiCode: "CB_VA01" },
      observations,
      "node_state_keyの重複禁止CB_VA01を観測できませんでした",
    );
    const current = inserts.find(({ status }) => status === "fulfilled")?.value;
    assertObserved(
      Boolean(current),
      { fulfilledCount: 1 },
      inserts.map((outcome) =>
        outcome.status === "fulfilled"
          ? { status: "fulfilled" }
          : { status: "rejected", error: summarizeError(outcome.reason) },
      ),
      "同一node_state_keyへの並行insertの片方が成功しませんでした",
    );
    const revisions = await Promise.allSettled([
      repository.upsertNodeState({
        value: { ...current.value, status_reason: `${scope}_revision_a` },
        expected_revision: current.revision,
      }),
      repository.upsertNodeState({
        value: { ...current.value, status_reason: `${scope}_revision_b` },
        expected_revision: current.revision,
      }),
    ]);
    assert.equal(
      revisions.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    const revisionError = revisions.find(
      ({ status }) => status === "rejected",
    )?.reason;
    assertObserved(
      revisionError instanceof RepositoryError &&
        revisionError.code === "REVISION_CONFLICT",
      { name: "RepositoryError", code: "REVISION_CONFLICT" },
      summarizeError(revisionError),
      "stale revisionはREVISION_CONFLICTでなければなりません",
    );
    // 並行更新の敗者コードは非決定的(実測: 409 GAIA_CO02 または 400 GAIA_DA02 =
    // DBロック競合)。どちらでも安定code REVISION_CONFLICT へ裁定されることが契約。
    assertObserved(
      observations.some(
        ({ status, apiCode }) =>
          (status === 409 && apiCode === "GAIA_CO02") ||
          (status === 400 && apiCode === "GAIA_DA02"),
      ),
      { conflict: "409 GAIA_CO02 または 400 GAIA_DA02" },
      observations,
      "repository更新の競合(409 CO02/400 DA02)を観測できませんでした",
    );
    return {
      recordChecks,
      lockChecks,
      insertOutcomes: inserts.map(({ status }) => ({ status })),
      durableNodeStateCount: stored.length,
      revisionOutcomes: revisions.map((outcome) =>
        outcome.status === "fulfilled"
          ? { status: "fulfilled", revision: outcome.value.revision }
          : { status: "rejected", error: summarizeError(outcome.reason) },
      ),
      observations: observations.filter(({ status }) => status >= 400),
    };
  },
);
