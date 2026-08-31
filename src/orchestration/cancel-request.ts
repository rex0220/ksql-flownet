import type {
  CancelRequest,
  NetworkRunStatus,
} from "../domain/persistence-model.js";
import type {
  PersistenceRepository,
  Versioned,
} from "../persistence/repository.js";
import { RepositoryError } from "../persistence/repository.js";

export type CancelRequestErrorCode = "RUN_ALREADY_TERMINAL";

export class CancelRequestError extends Error {
  constructor(
    readonly code: CancelRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CancelRequestError";
  }
}

export interface ChangeCancelRequestInput {
  readonly repository: PersistenceRepository;
  readonly runId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly release: boolean;
  readonly now?: () => Date;
}

const TERMINAL = new Set<NetworkRunStatus>([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);

export async function changeCancelRequest(
  input: ChangeCancelRequestInput,
): Promise<Versioned<CancelRequest> | null> {
  const run = await input.repository.getRun(input.runId);
  const current = await input.repository.getCancelRequest(input.runId);
  if (input.release) {
    if (current === null || current.value.state === "RELEASED") return current;
    const at = (input.now ?? (() => new Date()))().toISOString();
    return input.repository.updateCancelRequest(input.runId, current.revision, {
      ...current.value,
      state: "RELEASED",
      released_at: at,
      release_reason: input.reason,
      release_requested_by: input.requestedBy,
    });
  }
  if (
    current?.value.state === "REQUESTED" ||
    current?.value.state === "ACCEPTED"
  )
    return current;
  if (TERMINAL.has(run.value.status))
    throw new CancelRequestError(
      "RUN_ALREADY_TERMINAL",
      `run '${input.runId}' is already terminal (${run.value.status})`,
    );
  const at = (input.now ?? (() => new Date()))().toISOString();
  const request: CancelRequest = {
    run_id: input.runId,
    state: "REQUESTED",
    requested_by: input.requestedBy,
    reason: input.reason,
    requested_at: at,
    accepted_at: null,
    released_at: null,
    release_reason: null,
    release_requested_by: null,
  };
  if (current === null) {
    try {
      return await input.repository.createCancelRequest(request);
    } catch (error) {
      if (
        !(error instanceof RepositoryError) ||
        error.code !== "DUPLICATE_RECORD"
      )
        throw error;
      const raced = await input.repository.getCancelRequest(input.runId);
      if (raced === null) throw error;
      return raced;
    }
  }
  return input.repository.updateCancelRequest(
    input.runId,
    current.revision,
    request,
  );
}

export function isCancelHold(
  request: Versioned<CancelRequest> | null,
): request is Versioned<CancelRequest> {
  return (
    request?.value.state === "REQUESTED" || request?.value.state === "ACCEPTED"
  );
}
