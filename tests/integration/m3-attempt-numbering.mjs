import assert from "node:assert/strict";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import { RepositoryError } from "../../dist/persistence/repository.js";
import {
  attemptFinalization,
  assertObserved,
  createObservedFetch,
  createRepository,
  makeState,
  runIntegration,
  summarizeError,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-attempt-numbering",
  async ({ config, scope }) => {
    const observations = [];
    const repository = createRepository(
      config,
      createObservedFetch(observations),
    );
    const nodeId = `${scope}_node`;
    let state = await repository.upsertNodeState({
      value: makeState(scope, nodeStateKey(scope, nodeId), { node_id: nodeId }),
      expected_revision: null,
    });
    const parallel = await Promise.allSettled([
      repository.createAttempt({
        node_state: state,
        node_attempt_id: `${scope}_attempt_1a`,
        invocation_id: `${scope}_invocation_a`,
      }),
      repository.createAttempt({
        node_state: state,
        node_attempt_id: `${scope}_attempt_1b`,
        invocation_id: `${scope}_invocation_b`,
      }),
    ]);
    const first = parallel.find(({ status }) => status === "fulfilled")?.value;
    const conflict = parallel.find(
      ({ status }) => status === "rejected",
    )?.reason;
    assertObserved(
      Boolean(first),
      { fulfilledCount: 1 },
      parallel.map((outcome) =>
        outcome.status === "fulfilled"
          ? { status: "fulfilled" }
          : { status: "rejected", error: summarizeError(outcome.reason) },
      ),
      "並行createAttemptの片方が成功しませんでした",
    );
    assertObserved(
      conflict instanceof RepositoryError &&
        conflict.code === "ATTEMPT_NUMBER_CONFLICT",
      { name: "RepositoryError", code: "ATTEMPT_NUMBER_CONFLICT" },
      summarizeError(conflict),
      "並行createAttemptの片方はATTEMPT_NUMBER_CONFLICTでなければなりません",
    );
    state = await repository.upsertNodeState({
      value: {
        ...state.value,
        status: "RUNNING",
        latest_attempt_no: 1,
        active_attempt_id: first.value.node_attempt_id,
      },
      expected_revision: state.revision,
    });
    await repository.finalizeAttempt(
      first.value.node_attempt_id,
      first.revision,
      attemptFinalization(),
    );
    state = await repository.upsertNodeState({
      value: { ...state.value, status: "SUCCESS", active_attempt_id: null },
      expected_revision: state.revision,
    });

    for (const attemptNo of [2, 3]) {
      state = await repository.upsertNodeState({
        value: { ...state.value, status: "WAITING" },
        expected_revision: state.revision,
      });
      const attempt = await repository.createAttempt({
        node_state: state,
        node_attempt_id: `${scope}_attempt_${attemptNo}`,
        invocation_id: `${scope}_invocation_${attemptNo}`,
      });
      assert.equal(attempt.value.attempt_no, attemptNo);
      state = await repository.upsertNodeState({
        value: {
          ...state.value,
          status: "RUNNING",
          latest_attempt_no: attemptNo,
          active_attempt_id: attempt.value.node_attempt_id,
        },
        expected_revision: state.revision,
      });
      await repository.finalizeAttempt(
        attempt.value.node_attempt_id,
        attempt.revision,
        attemptFinalization(),
      );
      state = await repository.upsertNodeState({
        value: { ...state.value, status: "SUCCESS", active_attempt_id: null },
        expected_revision: state.revision,
      });
    }
    const attempts = await repository.getAttempts(scope);
    const numbers = attempts
      .map(({ value }) => value.attempt_no)
      .sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3]);
    assertObserved(
      new Set(numbers).size === numbers.length,
      { unique: true },
      { attemptNumbers: numbers },
      "attempt_noが重複しています",
    );
    return {
      parallel: parallel.map((outcome) =>
        outcome.status === "fulfilled"
          ? {
              status: "fulfilled",
              attemptId: outcome.value.value.node_attempt_id,
            }
          : { status: "rejected", error: summarizeError(outcome.reason) },
      ),
      attemptNumbers: numbers,
      finalLatestAttemptNo: state.value.latest_attempt_no,
      conflictResponses: observations.filter(({ status }) => status >= 400),
    };
  },
);
