import {
  KintoneApiError,
  KintoneClient,
  type KintoneClientConfig,
  type KintoneRecord,
} from "../persistence/kintone/client.js";
import {
  parseRequestRecord,
  RequestValidationError,
  type RequestRecord,
  type TerminalRequestState,
  validateRequestRecord,
} from "./request-model.js";

export const DEFAULT_REQUEST_FETCH_LIMIT = 100;
export const MAX_REQUEST_FETCH_LIMIT = 500;

export interface KintoneRequestStoreConfig extends KintoneClientConfig {
  readonly fetchLimit?: number;
}

export interface RequestResult {
  readonly state: TerminalRequestState;
  readonly code: string;
  readonly message: string;
}

export interface InvalidRequestRecord {
  readonly id: string;
  readonly revision: number;
  readonly issues: readonly {
    readonly code: string;
    readonly field: string;
    readonly message: string;
  }[];
}

export interface RequestedRecords {
  readonly valid: readonly RequestRecord[];
  readonly invalid: readonly InvalidRequestRecord[];
  readonly skipped: number;
}

function field(value: string): { value: string } {
  return { value };
}

function conflict(error: unknown): boolean {
  return (
    error instanceof KintoneApiError &&
    (error.status === 409 ||
      error.apiCode === "GAIA_CO02" ||
      error.apiCode === "GAIA_DA02")
  );
}

function terminalMatches(
  record: RequestRecord,
  result: RequestResult,
): boolean {
  return (
    record.requestState === result.state &&
    record.resultCode === result.code &&
    record.resultMessage === result.message
  );
}

function withRevision(record: RequestRecord, revision: number): RequestRecord {
  return { ...record, revision };
}

function assertValid(record: RequestRecord): void {
  const issues = validateRequestRecord(record);
  if (issues.length > 0) throw new RequestValidationError(issues);
}

export class KintoneRequestStore {
  private readonly client: KintoneClient;
  private readonly fetchLimit: number;

  constructor(config: KintoneRequestStoreConfig) {
    const fetchLimit = config.fetchLimit ?? DEFAULT_REQUEST_FETCH_LIMIT;
    if (
      !Number.isSafeInteger(fetchLimit) ||
      fetchLimit < 1 ||
      fetchLimit > MAX_REQUEST_FETCH_LIMIT
    ) {
      throw new RangeError(
        `fetchLimit must be an integer from 1 to ${MAX_REQUEST_FETCH_LIMIT}`,
      );
    }
    this.fetchLimit = fetchLimit;
    this.client = new KintoneClient(config);
  }

  async listRequested(): Promise<RequestedRecords> {
    const records = await this.client.getRecords(
      `request_state in ("REQUESTED") order by 作成日時 asc, $id asc limit ${this.fetchLimit}`,
    );
    const valid: RequestRecord[] = [];
    const invalid: InvalidRequestRecord[] = [];
    let skipped = 0;
    for (const record of records) {
      const identity = this.readIdentity(record);
      if (identity === null) {
        skipped += 1;
        continue;
      }
      try {
        valid.push(parseRequestRecord(record));
      } catch (error) {
        if (!(error instanceof RequestValidationError)) throw error;
        invalid.push({ ...identity, issues: error.issues });
      }
    }
    return { valid, invalid, skipped };
  }

  async listAccepted(): Promise<readonly RequestRecord[]> {
    const records = await this.client.getRecords(
      `request_state in ("ACCEPTED") order by claim_heartbeat_at asc, $id asc limit ${this.fetchLimit}`,
    );
    return records.map(parseRequestRecord);
  }

  async rejectInvalid(
    request: Pick<InvalidRequestRecord, "id" | "revision">,
    result: RequestResult,
  ): Promise<void> {
    if (result.state !== "REJECTED") {
      throw new Error("invalid requests can only be REJECTED");
    }
    try {
      await this.client.putRecordById(request.id, request.revision, {
        request_state: field("REJECTED"),
        result_code: field(result.code),
        result_message: field(result.message),
      });
    } catch (error) {
      if (!conflict(error)) throw error;
    }
  }

  async claim(
    request: RequestRecord,
    claimedHost: string,
    now: string,
  ): Promise<RequestRecord | null> {
    if (request.requestState !== "REQUESTED") {
      throw new Error("only REQUESTED records can be claimed");
    }
    const claimed: RequestRecord = {
      ...request,
      requestState: "ACCEPTED",
      claimedAt: now,
      claimedHost,
      claimHeartbeatAt: now,
    };
    assertValid(claimed);
    try {
      const revision = await this.client.putRecordById(
        request.id,
        request.revision,
        {
          request_state: field("ACCEPTED"),
          claimed_at: field(now),
          claimed_host: field(claimedHost),
          claim_heartbeat_at: field(now),
        },
      );
      return withRevision(claimed, revision);
    } catch (error) {
      if (conflict(error)) return null;
      throw error;
    }
  }

  async heartbeat(request: RequestRecord, now: string): Promise<RequestRecord> {
    if (request.requestState !== "ACCEPTED") {
      throw new Error("only ACCEPTED records can receive a heartbeat");
    }
    const updated = { ...request, claimHeartbeatAt: now };
    assertValid(updated);
    const revision = await this.client.putRecordById(
      request.id,
      request.revision,
      { claim_heartbeat_at: field(now) },
    );
    return withRevision(updated, revision);
  }

  async writeResult(
    request: RequestRecord,
    result: RequestResult,
  ): Promise<RequestRecord> {
    if (
      request.requestState !== "ACCEPTED" &&
      !(request.requestState === "REQUESTED" && result.state === "REJECTED")
    ) {
      throw new Error(
        "results require ACCEPTED, except direct validation rejection from REQUESTED",
      );
    }
    const projected = this.resultRecord(request, result, request.revision);
    assertValid(projected);
    const update: KintoneRecord = {
      request_state: field(result.state),
      result_code: field(result.code),
      result_message: field(result.message),
    };
    try {
      const revision = await this.client.putRecordById(
        request.id,
        request.revision,
        update,
      );
      return this.resultRecord(request, result, revision);
    } catch (error) {
      if (!conflict(error)) throw error;
    }

    const current = await this.getById(request.id);
    if (current === null)
      throw new Error("request record disappeared after conflict");
    if (terminalMatches(current, result)) return current;
    const revision = await this.client.putRecordById(
      current.id,
      current.revision,
      update,
    );
    return this.resultRecord(current, result, revision);
  }

  private async getById(id: string): Promise<RequestRecord | null> {
    const records = await this.client.getRecords(`$id in ("${id}") limit 1`);
    const record = records[0];
    return record === undefined ? null : parseRequestRecord(record);
  }

  private resultRecord(
    request: RequestRecord,
    result: RequestResult,
    revision: number,
  ): RequestRecord {
    return withRevision(
      {
        ...request,
        requestState: result.state,
        resultCode: result.code,
        resultMessage: result.message,
      },
      revision,
    );
  }

  private readIdentity(
    record: KintoneRecord,
  ): Pick<InvalidRequestRecord, "id" | "revision"> | null {
    const id = record.$id?.value;
    const revision = record.$revision?.value;
    if (
      typeof id !== "string" ||
      !/^\d+$/.test(id) ||
      typeof revision !== "string" ||
      !/^\d+$/.test(revision)
    ) {
      return null;
    }
    const parsedRevision = Number(revision);
    if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 1)
      return null;
    return { id, revision: parsedRevision };
  }
}
