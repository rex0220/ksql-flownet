import type { StatusOutput, RunStatusOutput } from "../orchestration/status.js";
import {
  requestedBy,
  type FlownetChildClient,
} from "./flownet-child-client.js";
import type {
  InvalidRequestRecord,
  KintoneRequestStore,
  RequestResult,
} from "./kintone-request-store.js";
import type {
  PollRequestsConfig,
  PollRequestsNetwork,
} from "./poll-requests-config.js";
import type { RequestRecord } from "./request-model.js";
import {
  classifyCancelResult,
  classifyArchiveRun,
  classifyRunNetworkResult,
  classifyStartNetworkResult,
  rejected,
} from "./request-result.js";
import {
  prepareStartRequest,
  startNetworkNotAllowed,
} from "./start-request.js";

export interface RequestPollerDependencies {
  readonly store: Pick<
    KintoneRequestStore,
    | "listRequested"
    | "listAccepted"
    | "rejectInvalid"
    | "cancelBeforeClaim"
    | "claim"
    | "heartbeat"
    | "getById"
    | "writeResult"
  >;
  readonly child: Pick<
    FlownetChildClient,
    "status" | "runNetwork" | "startNetwork" | "cancelRun" | "archiveRun"
  >;
  readonly config: PollRequestsConfig;
  readonly host: string;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly log?: (code: string, detail: string) => void;
}

export interface PollRequestsSummary {
  readonly requested: number;
  readonly claimed: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly invalid: number;
  readonly skippedMalformed: number;
  readonly stale: number;
}

interface ResolvedRun {
  readonly network: PollRequestsNetwork;
  readonly status: StatusOutput;
  readonly run: RunStatusOutput;
}

export async function pollRequests(
  dependencies: RequestPollerDependencies,
): Promise<PollRequestsSummary> {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? (() => undefined);
  const listed = await dependencies.store.listRequested();
  // Establish the REQUESTED read boundary before performing any write. A failed
  // primary GET must leave both requests and stale candidates untouched.
  const stale = await recoverStale(dependencies, now, log);
  if (listed.skipped > 0) {
    log("REQUEST_RECORD_UNIDENTIFIABLE", `count=${listed.skipped}`);
  }
  let cancelled = 0;
  for (const invalid of listed.invalid) {
    if (invalid.cancelRequested === true) {
      if (await cancelBeforeClaim(dependencies, invalid, log)) cancelled += 1;
      continue;
    }
    await rejectInvalid(dependencies, invalid);
  }

  let claimedCount = 0;
  let completed = 0;
  for (const request of listed.valid) {
    if (request.cancelRequested) {
      if (await cancelBeforeClaim(dependencies, request, log)) cancelled += 1;
      continue;
    }
    const claimed = await dependencies.store.claim(
      request,
      dependencies.host,
      now().toISOString(),
    );
    if (claimed === null) continue;
    claimedCount += 1;
    const result = await processClaimed(dependencies, claimed, now, log);
    if (await finalizeResult(dependencies, result.request, result.result, log))
      completed += 1;
  }
  return {
    requested: listed.valid.length,
    claimed: claimedCount,
    completed,
    cancelled,
    invalid: listed.invalid.length,
    skippedMalformed: listed.skipped,
    stale,
  };
}

async function cancelBeforeClaim(
  dependencies: RequestPollerDependencies,
  request: Pick<
    InvalidRequestRecord,
    "id" | "revision" | "requestState" | "cancelRequested"
  >,
  log: (code: string, detail: string) => void,
): Promise<boolean> {
  const cancelled = await dependencies.store.cancelBeforeClaim(request, {
    state: "CANCELLED",
    code: "CANCELLED_BY_REQUESTER",
    message: "requester cancelled before claim",
  });
  if (!cancelled) log("CANCEL_FINALIZE_CONFLICT", `request_id=${request.id}`);
  return cancelled;
}

async function finalizeResult(
  dependencies: RequestPollerDependencies,
  request: RequestRecord,
  result: RequestResult,
  log: (code: string, detail: string) => void,
): Promise<boolean> {
  let current: RequestRecord | null;
  try {
    current = await dependencies.store.getById(request.id);
  } catch {
    log("RESULT_FINALIZE_ABANDONED", `request_id=${request.id}`);
    return false;
  }
  if (current?.requestState !== "ACCEPTED") {
    log("RESULT_STATE_MISMATCH", `request_id=${request.id}`);
    return false;
  }
  const finalized = current.cancelRequested
    ? { ...result, message: `${result.message} (cancel_ignored)` }
    : result;
  try {
    await dependencies.store.writeResult(current, finalized);
    return true;
  } catch {
    log("RESULT_FINALIZE_ABANDONED", `request_id=${request.id}`);
    return false;
  }
}

async function rejectInvalid(
  dependencies: RequestPollerDependencies,
  invalid: InvalidRequestRecord,
): Promise<void> {
  const codes = [...new Set(invalid.issues.map(({ code }) => code))].sort();
  await dependencies.store.rejectInvalid(invalid, {
    state: "REJECTED",
    code: "REQUEST_INVALID",
    message: `request validation failed: ${codes.join(",")}`,
  });
}

async function processClaimed(
  dependencies: RequestPollerDependencies,
  claimed: RequestRecord,
  now: () => Date,
  log: (code: string, detail: string) => void,
): Promise<{
  readonly request: RequestRecord;
  readonly result: RequestResult;
}> {
  if (claimed.requestType === "START") {
    return processStart(dependencies, claimed, now, log);
  }
  try {
    requestedBy(claimed);
  } catch {
    return {
      request: claimed,
      result: rejected(
        "REQUESTED_BY_INVALID",
        "Request creator correlation is invalid or too long",
      ),
    };
  }
  let resolved: ResolvedRun;
  try {
    const matches = await resolveRun(dependencies, claimed.runId);
    if (matches.length === 0) {
      return {
        request: claimed,
        result: rejected("RUN_NOT_FOUND", "Run was not found in the allowlist"),
      };
    }
    if (matches.length > 1) {
      return {
        request: claimed,
        result: rejected(
          "RUN_ID_AMBIGUOUS",
          "Run ID matched multiple allowed networks",
        ),
      };
    }
    resolved = matches[0]!;
  } catch {
    return {
      request: claimed,
      result: rejected(
        "STATUS_UNAVAILABLE",
        "Run status could not be verified",
      ),
    };
  }
  const review = reviewRequest(
    claimed,
    resolved,
    now().getTime(),
    dependencies.config.stalePrecisionAllowanceMs,
  );
  if (review !== null) return { request: claimed, result: review };

  switch (claimed.requestType) {
    case "RERUN":
      return withHeartbeat(
        dependencies,
        claimed,
        () => dependencies.child.runNetwork(resolved.network, claimed),
        classifyRunNetworkResult,
        now,
        log,
      );
    case "STOP":
    case "RELEASE":
      return withHeartbeat(
        dependencies,
        claimed,
        () =>
          dependencies.child.cancelRun(
            claimed,
            claimed.requestType === "RELEASE",
          ),
        (result) =>
          classifyCancelResult(result, claimed.requestType === "RELEASE"),
        now,
        log,
      );
    case "CLOSE":
      return withHeartbeat(
        dependencies,
        claimed,
        () => dependencies.child.archiveRun(resolved.network, claimed),
        classifyArchiveRun,
        now,
        log,
      );
    default: {
      const exhaustive: never = claimed.requestType;
      return exhaustive;
    }
  }
}

async function processStart(
  dependencies: RequestPollerDependencies,
  claimed: RequestRecord,
  now: () => Date,
  log: (code: string, detail: string) => void,
): Promise<{
  readonly request: RequestRecord;
  readonly result: RequestResult;
}> {
  if (claimed.runId.trim() !== "") {
    return {
      request: claimed,
      result: rejected(
        "RUN_ID_NOT_ALLOWED",
        "STARTではrun_idを指定できません。",
      ),
    };
  }
  const network =
    claimed.networkId === null
      ? undefined
      : dependencies.config.networks.find(
          ({ networkId }) => networkId === claimed.networkId,
        );
  if (network === undefined) {
    return {
      request: claimed,
      result: startNetworkNotAllowed("NOT_IN_ALLOWLIST"),
    };
  }
  if (!network.appStart) {
    return {
      request: claimed,
      result: startNetworkNotAllowed("APP_START_DISABLED"),
    };
  }
  let prepared = prepareStartRequest(network, claimed);
  if (!prepared.ok) return { request: claimed, result: prepared.result };
  try {
    requestedBy(claimed);
  } catch {
    return {
      request: claimed,
      result: rejected(
        "REQUESTED_BY_INVALID",
        "Request creator correlation is invalid or too long",
      ),
    };
  }
  // Minimize the definition gate-to-spawn window by re-reading immediately
  // before constructing the child invocation.
  prepared = prepareStartRequest(network, claimed);
  if (!prepared.ok) return { request: claimed, result: prepared.result };
  const input = prepared.value.input;
  return withHeartbeat(
    dependencies,
    claimed,
    () => dependencies.child.startNetwork(network, claimed, input),
    classifyStartNetworkResult,
    now,
    log,
  );
}

async function withHeartbeat<T>(
  dependencies: RequestPollerDependencies,
  initial: RequestRecord,
  start: () => Promise<T>,
  classify: (result: T) => RequestResult,
  now: () => Date,
  log: (code: string, detail: string) => void,
): Promise<{
  readonly request: RequestRecord;
  readonly result: RequestResult;
}> {
  const child = start().then(
    (value) => ({ kind: "done" as const, value }),
    () => ({ kind: "failed" as const }),
  );
  let current = initial;
  for (;;) {
    const event = await waitForChildOrHeartbeat(
      child,
      dependencies.config.heartbeatIntervalMs,
      dependencies.wait,
    );
    if (event.kind === "done") {
      return { request: current, result: classify(event.value) };
    }
    if (event.kind === "failed") {
      return {
        request: current,
        result: rejected(
          "CHILD_EXECUTION_FAILED",
          "child execution failed before a result was available",
        ),
      };
    }
    try {
      current = await dependencies.store.heartbeat(
        current,
        now().toISOString(),
      );
    } catch {
      log("CLAIM_HEARTBEAT_FAILED", `request_id=${current.id}`);
    }
  }
}

async function resolveRun(
  dependencies: RequestPollerDependencies,
  runId: string,
): Promise<ResolvedRun[]> {
  const matches: ResolvedRun[] = [];
  for (const network of dependencies.config.networks) {
    const status = await dependencies.child.status(network, runId);
    if (status === null) continue;
    const matchingRuns = status.runs.filter((run) => run.run_id === runId);
    for (const run of matchingRuns) matches.push({ network, status, run });
  }
  return matches;
}

export function reviewRequest(
  request: Pick<RequestRecord, "requestType">,
  resolved: Pick<ResolvedRun, "status" | "run">,
  nowMs: number,
  leaseAllowanceMs: number,
): RequestResult | null {
  const run = resolved.run;
  const live = hasLiveOwner(resolved.status, run, nowMs, leaseAllowanceMs);
  switch (request.requestType) {
    case "RERUN":
      if (!["CREATED", "RUNNING", "FAILED", "CANCELLED"].includes(run.status))
        return rejected(
          "RUN_STATUS_NOT_RERUNNABLE",
          `Run status ${run.status} is not rerunnable`,
        );
      if (!run.resume_allowed || run.lifecycle_status !== "ACTIVE")
        return rejected("RUN_NOT_RESUMABLE", "Run is not active and resumable");
      if (run.hold !== null || run.activity === "STOPPED")
        return rejected("RUN_ON_HOLD", "Run is on hold");
      if (run.activity === "LIVE" || live)
        return rejected("RUN_LIVE", "Run has a live Invocation owner");
      return null;
    case "STOP":
      if (["SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"].includes(run.status))
        return rejected("RUN_TERMINAL", `Run status ${run.status} is terminal`);
      if (run.activity === "STOPPED")
        return rejected("RUN_ALREADY_ON_HOLD", "Run is already on hold");
      return null;
    case "RELEASE":
      return run.hold === null
        ? rejected("RUN_NOT_ON_HOLD", "Run is not on hold")
        : null;
    case "START":
      return null;
    case "CLOSE":
      if (run.lifecycle_status === "ARCHIVED")
        return {
          state: "DONE",
          code: "RUN_ALREADY_ARCHIVED",
          message: "Run is already archived",
        };
      if (run.status === "SUCCESS")
        return rejected(
          "RUN_STATUS_NOT_CLOSABLE",
          "Successful Runs cannot be closed",
        );
      if (run.status === "UNKNOWN")
        return rejected(
          "RUN_UNKNOWN_NOT_CLOSABLE",
          "Unknown Runs cannot be closed",
        );
      if (run.status === "CREATED" || run.status === "RUNNING")
        return rejected("RUN_NOT_TERMINAL", "Run is not terminal");
      if (run.hold !== null) return rejected("RUN_ON_HOLD", "Run is on hold");
      if (live) return rejected("RUN_LIVE", "Run has a live Invocation owner");
      return null;
    default: {
      const exhaustive: never = request.requestType;
      return exhaustive;
    }
  }
}

export function hasLiveOwner(
  status: StatusOutput,
  run: RunStatusOutput,
  nowMs: number,
  leaseAllowanceMs: number,
): boolean {
  if (status.lock === null) return false;
  const invocationIds = new Set(
    (run.invocations ?? []).map(({ invocation_id }) => invocation_id),
  );
  return (
    invocationIds.has(status.lock.owner_invocation_id) &&
    nowMs <= Date.parse(status.lock.lease_expires_at) + leaseAllowanceMs
  );
}

async function recoverStale(
  dependencies: RequestPollerDependencies,
  now: () => Date,
  log: (code: string, detail: string) => void,
): Promise<number> {
  const accepted = await dependencies.store.listAccepted();
  let recovered = 0;
  const nowMs = now().getTime();
  for (const request of accepted) {
    const heartbeat = request.claimHeartbeatAt;
    if (
      heartbeat === null ||
      nowMs <=
        Date.parse(heartbeat) +
          dependencies.config.staleAfterMs +
          dependencies.config.stalePrecisionAllowanceMs
    ) {
      continue;
    }
    try {
      if (request.requestType === "START") {
        const recoveredStart = await recoverStaleStart(
          dependencies,
          request,
          nowMs,
        );
        if (!recoveredStart) continue;
        await dependencies.store.writeResult(
          request,
          rejected(
            "STALE",
            "Execution and result are unknown; do not request another operation until Run and audit records are reconciled",
          ),
        );
        recovered += 1;
        continue;
      }
      const matches = await resolveRun(dependencies, request.runId);
      if (matches.length !== 1) continue;
      const resolved = matches[0]!;
      if (
        resolved.run.activity === "LIVE" ||
        hasLiveOwner(
          resolved.status,
          resolved.run,
          nowMs,
          dependencies.config.stalePrecisionAllowanceMs,
        )
      ) {
        continue;
      }
      await dependencies.store.writeResult(
        request,
        rejected(
          "STALE",
          "Execution and result are unknown; do not request another operation until Run and audit records are reconciled",
        ),
      );
      recovered += 1;
    } catch {
      log("STALE_STATUS_UNAVAILABLE", `request_id=${request.id}`);
    }
  }
  return recovered;
}

async function recoverStaleStart(
  dependencies: RequestPollerDependencies,
  request: RequestRecord,
  nowMs: number,
): Promise<boolean> {
  if (request.networkId === null) return false;
  const network = dependencies.config.networks.find(
    ({ networkId }) => networkId === request.networkId,
  );
  if (network === undefined) return false;
  const prepared = prepareStartRequest(network, request);
  if (!prepared.ok) return false;
  const status = await dependencies.child.status(network, {
    businessKey: prepared.value.businessKey,
  });
  if (status === null) return false;
  const matches = status.runs.filter(
    ({ business_key }) => business_key === prepared.value.businessKey,
  );
  if (matches.length !== 1) return false;
  const run = matches[0]!;
  return (
    run.activity !== "LIVE" &&
    !hasLiveOwner(
      status,
      run,
      nowMs,
      dependencies.config.stalePrecisionAllowanceMs,
    )
  );
}

function waitForChildOrHeartbeat<T>(
  child: Promise<
    { readonly kind: "done"; readonly value: T } | { readonly kind: "failed" }
  >,
  milliseconds: number,
  customWait: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "failed" }
  | { readonly kind: "heartbeat" }
> {
  if (customWait !== undefined) {
    return Promise.race([
      child,
      customWait(milliseconds).then(() => ({ kind: "heartbeat" as const })),
    ]);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ kind: "heartbeat" }),
      milliseconds,
    );
    void child.then((event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}
