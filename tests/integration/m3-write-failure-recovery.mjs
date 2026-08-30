import assert from "node:assert/strict";

import { nodeStateKey } from "../../dist/domain/canonical-record-key.js";
import {
  reconcileRun,
  ReconciliationRequiredError,
} from "../../dist/orchestration/reconciliation.js";
import {
  attemptFinalization,
  assertObserved,
  createRepository,
  getRecords,
  makeRun,
  makeState,
  runIntegration,
  summarizeError,
  uploadBundle,
} from "./support.mjs";

await runIntegration(
  import.meta.url,
  "m3-write-failure-recovery",
  async ({ config, scope }) => {
    const repository = createRepository(config);
    const bundle = await uploadBundle(config, scope);

    async function setup(suffix, runOverrides = {}) {
      const runId = `${scope}_${suffix}`;
      const nodeId = `${runId}_node`;
      await repository.createRun(makeRun(runId, bundle, runOverrides));
      const state = await repository.upsertNodeState({
        value: makeState(runId, nodeStateKey(runId, nodeId), {
          node_id: nodeId,
        }),
        expected_revision: null,
      });
      return { runId, state };
    }

    async function start(runId, state) {
      const attempt = await repository.createAttempt({
        node_state: state,
        node_attempt_id: `${runId}_attempt`,
        invocation_id: `${runId}_invocation`,
      });
      const running = await repository.upsertNodeState({
        value: {
          ...state.value,
          status: "RUNNING",
          latest_attempt_no: 1,
          active_attempt_id: attempt.value.node_attempt_id,
        },
        expected_revision: state.revision,
      });
      return { attempt, running };
    }

    const caseA = await setup("a");
    const startedA = await start(caseA.runId, caseA.state);
    await repository.finalizeAttempt(
      startedA.attempt.value.node_attempt_id,
      startedA.attempt.revision,
      attemptFinalization("SUCCESS"),
    );
    const repairedA = await reconcileRun(repository, caseA.runId);
    const stateA = (await repository.getNodeStates(caseA.runId))[0];
    const auditsA = await getRecords(
      config,
      "audit",
      `record_type in ("OPERATION_AUDIT") and run_id in ("${caseA.runId}")`,
    );
    assert.equal(stateA.value.status, "SUCCESS");
    assert.equal(stateA.value.active_attempt_id, null);
    assertObserved(
      repairedA.repaired.some(
        ({ type }) => type === "TERMINAL_ATTEMPT_APPLIED",
      ),
      { repairedType: "TERMINAL_ATTEMPT_APPLIED" },
      repairedA,
      "terminal Attemptの修復結果が不正です",
    );
    assertObserved(
      auditsA.some(
        (record) => record.result_code.value === "TERMINAL_ATTEMPT_APPLIED",
      ),
      { auditResultCode: "TERMINAL_ATTEMPT_APPLIED" },
      auditsA.map((record) => ({
        resultCode: record.result_code?.value ?? null,
        recordKey: record.record_key?.value ?? null,
      })),
      "terminal Attempt修復の監査記録を観測できませんでした",
    );

    const caseB = await setup("b");
    const startedB = await start(caseB.runId, caseB.state);
    await repository.upsertNodeState({
      value: { ...startedB.running.value, status: "SUCCESS" },
      expected_revision: startedB.running.revision,
    });
    let stoppedCauseB;
    try {
      await reconcileRun(repository, caseB.runId);
    } catch (error) {
      stoppedCauseB = error;
    }
    const stoppedB = summarizeError(stoppedCauseB);
    assertObserved(
      stoppedCauseB instanceof ReconciliationRequiredError &&
        stoppedCauseB.result.inconsistencies.some(
          ({ code }) => code === "STATE_TERMINAL_ATTEMPT_RUNNING",
        ),
      {
        name: "ReconciliationRequiredError",
        inconsistencyCode: "STATE_TERMINAL_ATTEMPT_RUNNING",
      },
      stoppedB,
      "terminal State + RUNNING Attemptの停止結果が不正です",
    );
    const stateB = (await repository.getNodeStates(caseB.runId))[0];
    const attemptB = (await repository.getAttempts(caseB.runId))[0];
    assert.equal(stateB.value.status, "SUCCESS");
    assert.equal(attemptB.value.status, "RUNNING");

    const caseC = await setup("c", { status: "RUNNING" });
    const repairedC = await reconcileRun(repository, caseC.runId);
    const runC = await repository.getRun(caseC.runId);
    assert.equal(runC.value.status, "CREATED");
    assertObserved(
      repairedC.repaired.some(
        ({ type }) => type === "RUN_AGGREGATE_RECOMPUTED",
      ),
      { repairedType: "RUN_AGGREGATE_RECOMPUTED" },
      repairedC,
      "Run aggregateの修復結果が不正です",
    );

    return {
      terminalAttemptRepair: {
        result: repairedA,
        rereadState: stateA,
        operationAuditCount: auditsA.length,
      },
      terminalStateRunningAttemptStop: {
        error: stoppedB,
        rereadState: stateB,
        rereadAttempt: attemptB,
      },
      aggregateRepair: { result: repairedC, rereadRun: runC },
    };
  },
);
