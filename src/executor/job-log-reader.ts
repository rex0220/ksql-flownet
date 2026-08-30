import {
  KintoneApiError,
  KintoneTransportError,
} from "../persistence/kintone/client.js";

export interface JobLogLookup {
  readonly attemptId: string;
  readonly executionId?: string;
}

export interface JobLogMarker {
  readonly runnerExecutionStartedAt: string | null;
  readonly executionId: string | null;
}

export interface JobLogAttemptResult extends JobLogMarker {
  readonly status: string;
  readonly finishedAt: string | null;
}

export interface JobLogReader {
  findExecutionStarted(lookup: JobLogLookup): Promise<JobLogMarker | null>;
  findAttemptResult(attemptId: string): Promise<JobLogAttemptResult | null>;
}

export interface KintoneJobLogReaderOptions {
  readonly baseUrl: string;
  readonly appId: number;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export class KintoneJobLogReader implements JobLogReader {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KintoneJobLogReaderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async findExecutionStarted(
    lookup: JobLogLookup,
  ): Promise<JobLogMarker | null> {
    const record = await this.findRecord(lookup);
    return record === null
      ? null
      : {
          runnerExecutionStartedAt: fieldString(
            record.runner_execution_started_at,
          ),
          executionId: fieldString(record.execution_id),
        };
  }

  async findAttemptResult(
    attemptId: string,
  ): Promise<JobLogAttemptResult | null> {
    const record = await this.findRecord({ attemptId });
    if (record === null) return null;
    const status = fieldString(record.status);
    if (status === null) throw new Error("job log status is missing");
    return {
      status,
      runnerExecutionStartedAt: fieldString(record.runner_execution_started_at),
      executionId: fieldString(record.execution_id),
      finishedAt: fieldString(record.finished_at),
    };
  }

  private async findRecord(
    lookup: JobLogLookup,
  ): Promise<Record<string, unknown> | null> {
    const clauses = [`attempt_id = "${escapeQuery(lookup.attemptId)}"`];
    if (lookup.executionId)
      clauses.push(`execution_id = "${escapeQuery(lookup.executionId)}"`);
    const query = `${clauses.join(" and ")} order by runner_execution_started_at desc limit 2`;
    const url = new URL(
      `${this.options.baseUrl.replace(/\/$/, "")}/k/v1/records.json`,
    );
    url.searchParams.set("app", String(this.options.appId));
    url.searchParams.set("query", query);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "X-Cybozu-API-Token": this.options.apiToken },
      });
    } catch (error) {
      throw new KintoneTransportError(error);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const apiCode =
        isRecord(body) && typeof body.code === "string" ? body.code : null;
      throw new KintoneApiError(response.status, apiCode, body);
    }
    if (!isRecord(body) || !Array.isArray(body.records))
      throw new Error("job log GET returned an invalid response");
    const records = body.records as unknown[];
    if (records.length === 0) return null;
    if (records.length > 1) throw new Error("job log lookup is ambiguous");
    const record = records[0];
    if (!isRecord(record)) throw new Error("job log record is invalid");
    return record;
  }
}

export type MissingResultDecision = "NOT_EXECUTED" | "UNKNOWN";

export function decideMissingResult(input: {
  readonly orchestratorExecutionStartedAt: string | null;
  readonly runnerExecutionStartedAt: string | null;
  readonly durableLaunchFailureConfirmed: boolean;
}): MissingResultDecision {
  if (
    input.orchestratorExecutionStartedAt === null &&
    input.runnerExecutionStartedAt === null
  )
    return "NOT_EXECUTED";
  if (
    input.orchestratorExecutionStartedAt !== null &&
    input.runnerExecutionStartedAt === null &&
    input.durableLaunchFailureConfirmed
  )
    return "NOT_EXECUTED";
  return "UNKNOWN";
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldString(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.value === "string" && value.value.length > 0
    ? value.value
    : null;
}
