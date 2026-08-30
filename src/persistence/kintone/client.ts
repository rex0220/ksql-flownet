export interface KintoneClientConfig {
  baseUrl: string;
  appId: number;
  apiToken: string;
  fetch?: typeof fetch;
}

export type KintoneFieldValue = { value: unknown };
export type KintoneRecord = Record<string, KintoneFieldValue>;

export class KintoneApiError extends Error {
  readonly status: number;
  readonly apiCode: string | null;
  readonly responseBody: unknown;

  constructor(status: number, apiCode: string | null, responseBody: unknown) {
    super(`kintone API returned ${status}${apiCode ? ` ${apiCode}` : ""}`);
    this.name = "KintoneApiError";
    this.status = status;
    this.apiCode = apiCode;
    this.responseBody = responseBody;
  }
}

export class KintoneTransportError extends Error {
  readonly causeDetail: unknown;

  constructor(causeDetail: unknown) {
    super("kintone request outcome is unknown");
    this.name = "KintoneTransportError";
    this.causeDetail = causeDetail;
  }
}

export class KintoneClient {
  private readonly baseUrl: string;
  private readonly appId: number;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: KintoneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.appId = config.appId;
    this.apiToken = config.apiToken;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async getRecords(query: string): Promise<KintoneRecord[]> {
    const url = new URL(`${this.baseUrl}/k/v1/records.json`);
    url.searchParams.set("app", String(this.appId));
    url.searchParams.set("query", query);
    const body = await this.request("GET", url);
    return (body as { records: KintoneRecord[] }).records;
  }

  async postRecord(
    record: KintoneRecord,
  ): Promise<{ id: string; revision: number }> {
    const body = await this.request(
      "POST",
      `${this.baseUrl}/k/v1/record.json`,
      {
        app: this.appId,
        record,
      },
    );
    const result = body as { id: string; revision: string };
    return { id: result.id, revision: Number(result.revision) };
  }

  async putRecord(
    recordKey: string,
    revision: number,
    record: KintoneRecord,
  ): Promise<number> {
    const body = await this.request("PUT", `${this.baseUrl}/k/v1/record.json`, {
      app: this.appId,
      updateKey: { field: "record_key", value: recordKey },
      revision,
      record,
    });
    return Number((body as { revision: string }).revision);
  }

  async putRecordById(
    id: string,
    revision: number,
    record: KintoneRecord,
  ): Promise<number> {
    const body = await this.request("PUT", `${this.baseUrl}/k/v1/record.json`, {
      app: this.appId,
      id,
      revision,
      record,
    });
    return Number((body as { revision: string }).revision);
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    url: string | URL,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "X-Cybozu-API-Token": this.apiToken,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new KintoneTransportError(error);
    }
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        typeof responseBody === "object" &&
        responseBody !== null &&
        "code" in responseBody &&
        typeof responseBody.code === "string"
          ? responseBody.code
          : null;
      throw new KintoneApiError(response.status, code, responseBody);
    }
    return responseBody;
  }
}
