import { createHash } from "node:crypto";

import {
  createKintoneClient,
  deleteRecord,
  field,
  insertRecord,
  summarizeError,
  updateRecord,
} from "../../lib/kintone.mjs";

const TERMINAL_ATTEMPT_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);

function fields(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([code, value]) => [
        code,
        field(Array.isArray(value) ? JSON.stringify(value) : value),
      ]),
  );
}

function escapeQuery(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function dropdownIn(fieldCode, value) {
  return `${fieldCode} in ("${escapeQuery(value)}")`;
}

function textEquals(fieldCode, value) {
  return `${fieldCode} = "${escapeQuery(value)}"`;
}

function recordQuery(recordType, runId) {
  return `${dropdownIn("record_type", recordType)} and ${textEquals("run_id", runId)} order by $id asc`;
}

export function nodeStateQuery(runId, nodeId) {
  return `${dropdownIn("record_type", "NODE_STATE")} and ${textEquals("run_id", runId)} and ${textEquals("node_id", nodeId)}`;
}

export function lockReleaseTombstone(invocationId) {
  const direct = `LOCKDONE:${invocationId}`;
  if (direct.length <= 64) return direct;
  const digest = createHash("sha256")
    .update(String(invocationId), "utf8")
    .digest("base64url");
  return `LOCKDONE:sha256:${digest}`;
}

function makeFailureController(fetchImplementation, failAt) {
  let calls = 0;
  let enabled = Number.isSafeInteger(failAt) && failAt > 0;
  return {
    fetch: async (...arguments_) => {
      calls += 1;
      if (enabled && calls >= failAt) {
        throw new Error(
          `INJECTED_AUDIT_UNREACHABLE: audit call ${calls} (injected, not kintone behavior)`,
        );
      }
      return fetchImplementation(...arguments_);
    },
    disable() {
      enabled = false;
    },
    get calls() {
      return calls;
    },
  };
}

export function createLayoutAdapter({
  layoutName,
  config,
  fetchImplementation = globalThis.fetch,
  auditFailureAt,
}) {
  if (!new Set(["1app", "2app"]).has(layoutName)) {
    throw new Error(`未対応のlayout名です: ${layoutName}`);
  }

  const auditFailure = makeFailureController(
    fetchImplementation,
    auditFailureAt,
  );
  const clients =
    layoutName === "1app"
      ? {
          integrated: createKintoneClient(
            {
              baseUrl: config.baseUrl,
              ...config.oneApp.integrated,
            },
            fetchImplementation,
          ),
        }
      : {
          execution: createKintoneClient(
            {
              baseUrl: config.baseUrl,
              ...config.twoApp.execution,
            },
            fetchImplementation,
          ),
          audit: createKintoneClient(
            { baseUrl: config.baseUrl, ...config.twoApp.audit },
            auditFailure.fetch,
          ),
        };
  const created = new Map();
  const operationLog = [];
  const findings = [
    {
      code: "A_LOCK_RELEASE_SCHEMA_GAP",
      severity: "decision-input",
      detail:
        "必須+重複禁止のキーはtombstone書き換え方式が必要（実測CB_VA01）。本番アプリ設計（D-08）ではlock keyフィールドを非必須にするか、lock_key_done等の退避フィールドとRELEASED statusを設ける。",
    },
    {
      code: "A_DROPDOWN_QUERY_OPERATOR_CONSTRAINT",
      severity: "decision-input",
      detail:
        "ドロップダウンは=ではなくin/not inのみ対応する（実測GAIA_IQ03）。FN-04 repositoryのクエリ層はフィールド型ごとの演算子制約を吸収する必要がある。",
    },
  ];

  function roleFor(kind) {
    if (layoutName === "1app") return "integrated";
    return kind === "audit" ? "audit" : "execution";
  }

  function endpoint(kind) {
    const role = roleFor(kind);
    const appConfig =
      layoutName === "1app"
        ? config.oneApp.integrated
        : kind === "audit"
          ? config.twoApp.audit
          : config.twoApp.execution;
    return { role, app: appConfig.app, client: clients[role] };
  }

  function track(role, app, id, revision, recordType) {
    const reference = {
      role,
      app,
      id: String(id),
      revision: String(revision),
      recordType,
    };
    created.set(`${role}:${id}`, reference);
    return reference;
  }

  async function insert(kind, recordType, values, operation) {
    const { role, app, client } = endpoint(kind);
    const response = await insertRecord(client, app, {
      record_type: field(recordType),
      ...fields(values),
    });
    const reference = track(
      role,
      app,
      response.id,
      response.revision,
      recordType,
    );
    operationLog.push({ operation, recordType, phase: "completed" });
    return reference;
  }

  async function update(reference, values, operation, expectedRevision) {
    const revision = String(expectedRevision ?? reference.revision);
    const response = await updateRecord(
      clients[reference.role],
      reference.app,
      reference.id,
      revision,
      fields(values),
    );
    reference.revision = String(response.revision);
    operationLog.push({
      operation,
      recordType: reference.recordType,
      phase: "completed",
    });
    return reference;
  }

  async function query(kind, queryText) {
    const { app, client } = endpoint(kind);
    const response = await client.request("records", {
      query: { app, query: queryText },
    });
    return response.records ?? [];
  }

  async function createRun(
    dataset,
    { mode = "NEW", selected, preserved = [], blocked = [] } = {},
  ) {
    const now = dataset.now();
    const run = await insert(
      "execution",
      "NETWORK_RUN",
      {
        record_key: `RUN:${dataset.runId}`,
        run_id: dataset.runId,
        network_id: dataset.networkId,
        business_key: dataset.businessKey,
        max_active_runs: 1,
        status: "CREATED",
        lifecycle_status: "ACTIVE",
        resume_allowed: "true",
        as_of: now,
        definition_schema_version: 1,
        definition_sha256: "sha256:spike-a-definition",
        source_bundle_sha256: "sha256:spike-a-bundle",
        resolved_profile_snapshot: JSON.stringify({ profile: dataset.profile }),
        resolved_profile_sha256: "sha256:spike-a-profile",
        ksql_flow_version: "spike",
        engine_version: "spike",
        dialect: 1,
        created_at: now,
        updated_at: now,
      },
      "createRun",
    );
    const invocation = await createInvocation(dataset, {
      invocationId: dataset.invocationId,
      mode,
      selected: selected ?? dataset.nodes.map((node) => node.nodeId),
      preserved,
      blocked,
    });
    const states = new Map();
    for (const node of dataset.nodes) {
      const state = await upsertNodeState({
        dataset,
        node,
        values: {
          status: "WAITING",
          latest_attempt_no: 0,
          active_attempt_id: "",
          blocked_by: [],
          revision: 1,
          updated_at: dataset.now(),
        },
      });
      states.set(node.nodeId, state);
    }
    return { run, invocation, states };
  }

  async function createInvocation(
    dataset,
    { invocationId, mode, selected, preserved = [], blocked = [] },
  ) {
    return insert(
      "audit",
      "RUN_INVOCATION",
      {
        record_key: `INV:${invocationId}`,
        run_id: dataset.runId,
        invocation_id: invocationId,
        mode,
        requested_by: "spike-a-script",
        host: "spike-a",
        started_at: dataset.now(),
        status: "RUNNING",
        selected_node_ids: selected,
        preserved_node_ids: preserved,
        blocked_node_ids: blocked,
        reason: mode === "RESUME" ? "resume incomplete run" : "new run",
      },
      "createInvocation",
    );
  }

  async function finalizeInvocation(reference, dataset, status, resultCode) {
    return update(
      reference,
      {
        status,
        result_code: resultCode,
        finished_at: dataset.now(),
      },
      "finalizeInvocation",
    );
  }

  async function upsertNodeState({
    dataset,
    node,
    reference,
    values,
    revision,
  }) {
    if (!reference) {
      return insert(
        "execution",
        "NODE_STATE",
        {
          record_key: `STATE:${node.nodeStateKey}`,
          run_id: dataset.runId,
          node_state_id: node.nodeStateId,
          node_state_key: node.nodeStateKey,
          node_id: node.nodeId,
          job_id: node.jobId,
          idempotent: String(node.idempotent),
          trigger_rule: "all_success",
          ...values,
        },
        "upsertNodeState.insert",
      );
    }
    const nextBusinessRevision = Number(revision ?? reference.revision) + 1;
    return update(
      reference,
      { ...values, revision: nextBusinessRevision },
      "upsertNodeState.update",
      revision,
    );
  }

  async function insertAttempt({ dataset, node, invocationId, attemptNo }) {
    const attemptId = dataset.attemptId(node.nodeId, attemptNo);
    const reference = await insert(
      "audit",
      "NODE_ATTEMPT",
      {
        record_key: `ATT:${attemptId}`,
        run_id: dataset.runId,
        node_attempt_id: attemptId,
        attempt_key: dataset.attemptKey(node.nodeId, attemptNo),
        node_id: node.nodeId,
        job_id: node.jobId,
        invocation_id: invocationId,
        attempt_no: attemptNo,
        status: "RUNNING",
        read_count: 0,
        written_count: 0,
      },
      "insertAttempt",
    );
    return { reference, attemptId, attemptNo };
  }

  async function markAttemptExecutionStarted(attempt, dataset) {
    await update(
      attempt.reference,
      {
        execution_started_at: dataset.now(),
        runner_execution_started_at: dataset.now(),
        execution_id: `ksql_${attempt.attemptId}`,
      },
      "markAttemptExecutionStarted",
    );
    return attempt;
  }

  async function finalizeAttempt(attempt, dataset, status, resultCode) {
    await update(
      attempt.reference,
      {
        status,
        result_code: resultCode,
        finished_at: dataset.now(),
        duration_sec: 1,
        read_count: status === "SUCCESS" ? 10 : 5,
        written_count: status === "SUCCESS" ? 10 : 2,
        error_message: status === "FAILED" ? "injected node failure" : "",
      },
      "finalizeAttempt",
    );
    return attempt;
  }

  async function updateRunAggregate(reference, dataset, status) {
    return update(
      reference,
      {
        status,
        started_at: dataset.now(),
        finished_at: TERMINAL_ATTEMPT_STATUSES.has(status)
          ? dataset.now()
          : null,
        updated_at: dataset.now(),
      },
      "updateRunAggregate",
    );
  }

  async function acquireNetworkLock(dataset, invocationId) {
    const now = dataset.now();
    try {
      const reference = await insert(
        "execution",
        "NETWORK_LOCK",
        {
          record_key: `LOCK:${dataset.lockKey}`,
          lock_key: dataset.lockKey,
          network_id: dataset.networkId,
          profile: dataset.profile,
          owner_invocation_id: invocationId,
          lease_token: `lease_${dataset.runId.slice(-16)}`,
          lease_expires_at: new Date(Date.parse(now) + 300_000).toISOString(),
          heartbeat_at: now,
          status: "RUNNING",
          revision: 1,
        },
        "acquireNetworkLock",
      );
      reference.invocationId = invocationId;
      return reference;
    } catch (error) {
      const records = await query(
        "execution",
        `${textEquals("record_key", `LOCK:${dataset.lockKey}`)} order by $id asc`,
      );
      error.lockAdjudication = {
        persistedCount: records.length,
        verdict: records.length === 1 ? "LOCK_CONFLICT" : "LOCK_UNAVAILABLE",
      };
      throw error;
    }
  }

  async function releaseNetworkLock(reference) {
    try {
      await update(
        reference,
        {
          record_key: lockReleaseTombstone(reference.invocationId),
          lock_key: "",
          owner_invocation_id: "",
          lease_token: "",
          status: "SUCCESS",
          revision: Number(reference.revision) + 1,
        },
        "releaseNetworkLock",
      );
      return { released: true, protocol: "tombstone-and-unique-key-clear" };
    } catch (error) {
      findings.push({
        code: "A_LOCK_RELEASE_UPDATE_REJECTED",
        severity: "observed",
        detail: summarizeError(error),
      });
      return {
        released: false,
        protocol: "tombstone-and-unique-key-clear",
        error: summarizeError(error),
      };
    }
  }

  async function reconcile(dataset) {
    const callsBefore = apiCalls();
    const repaired = [];
    const inconsistent = [];
    const states = await query(
      "execution",
      recordQuery("NODE_STATE", dataset.runId),
    );
    for (const state of states) {
      if (state.status?.value !== "RUNNING") continue;
      const activeAttemptId = state.active_attempt_id?.value;
      if (!activeAttemptId) {
        inconsistent.push({
          nodeId: state.node_id?.value,
          reason: "missing-active-attempt",
        });
        continue;
      }
      const attempts = await query(
        "audit",
        `${dropdownIn("record_type", "NODE_ATTEMPT")} and ${textEquals("node_attempt_id", activeAttemptId)} order by $id asc`,
      );
      if (attempts.length !== 1) {
        inconsistent.push({
          nodeId: state.node_id?.value,
          reason: "active-attempt-cardinality",
          count: attempts.length,
        });
        continue;
      }
      const attemptStatus = attempts[0].status?.value;
      if (!TERMINAL_ATTEMPT_STATUSES.has(attemptStatus)) continue;
      const reference = track(
        roleFor("execution"),
        endpoint("execution").app,
        state.$id.value,
        state.$revision.value,
        "NODE_STATE",
      );
      await update(
        reference,
        {
          status: attemptStatus,
          active_attempt_id: "",
          status_reason: "reconciled from terminal active attempt",
          revision: Number(state.revision?.value ?? state.$revision.value) + 1,
          finished_at: dataset.now(),
          updated_at: dataset.now(),
        },
        "reconcile.repairNodeState",
      );
      await insert(
        "audit",
        "OPERATION_AUDIT",
        {
          record_key: `OP:${activeAttemptId}`,
          run_id: dataset.runId,
          reason: "AUTO_RECONCILED_TERMINAL_ATTEMPT",
          resolved_at: dataset.now(),
        },
        "reconcile.audit",
      );
      repaired.push({
        nodeId: state.node_id.value,
        attemptId: activeAttemptId,
        status: attemptStatus,
      });
    }
    return {
      detected: repaired.length + inconsistent.length,
      repaired,
      inconsistent,
      additionalApiCalls: apiCalls() - callsBefore,
      failClosed: inconsistent.length > 0,
    };
  }

  function apiCalls() {
    return Object.values(clients).reduce(
      (sum, client) => sum + client.apiCalls,
      0,
    );
  }

  function measurements() {
    const breakdown = Object.entries(clients).flatMap(([role, client]) =>
      client.payloadMeasurements.map((measurement) => ({
        role,
        ...measurement,
      })),
    );
    return {
      apiCalls: apiCalls(),
      payload: {
        requestBytes: breakdown.reduce(
          (sum, item) => sum + (item.requestBytes ?? 0),
          0,
        ),
        responseBytes: breakdown.reduce(
          (sum, item) => sum + item.responseBytes,
          0,
        ),
        unmeasuredRequestBodies: breakdown.filter(
          (item) => item.requestBytes === null,
        ).length,
        breakdown,
      },
    };
  }

  async function cleanup() {
    auditFailure.disable();
    const warnings = [];
    const residualIds = [];
    const references = [...created.values()].reverse();
    for (const reference of references) {
      try {
        // 削除権限はスパイク実行後のテスト清掃専用。通常運用のlock解放には使わない。
        await deleteRecord(
          clients[reference.role],
          reference.app,
          reference.id,
          "-1",
        );
        created.delete(`${reference.role}:${reference.id}`);
      } catch (error) {
        warnings.push({
          id: reference.id,
          appRole: reference.role,
          error: summarizeError(error),
        });
        residualIds.push({ id: reference.id, appRole: reference.role });
      }
    }
    return { warnings, residualIds };
  }

  return {
    layoutName,
    createRun,
    createInvocation,
    finalizeInvocation,
    upsertNodeState,
    insertAttempt,
    markAttemptExecutionStarted,
    finalizeAttempt,
    updateRunAggregate,
    acquireNetworkLock,
    releaseNetworkLock,
    reconcile,
    query,
    cleanup,
    measurements,
    findings,
    operationLog,
    auditFailure,
  };
}
