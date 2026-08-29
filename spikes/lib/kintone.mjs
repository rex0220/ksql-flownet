export class KintoneError extends Error {
  constructor(message, { status, code, response }) {
    super(message);
    this.name = "KintoneError";
    this.status = status;
    this.code = code ?? null;
    this.response = response ?? null;
  }
}

export function createKintoneClient(
  config,
  fetchImplementation = globalThis.fetch,
) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("Node.js組込みfetchが利用できません。");
  }
  let apiCalls = 0;
  const payloadMeasurements = [];

  async function request(
    path,
    { method = "GET", body, query, raw = false } = {},
  ) {
    apiCalls += 1;
    const url = new URL(`/k/v1/${path}.json`, `${config.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, value);
    }
    const headers = { "X-Cybozu-API-Token": config.token };
    if (body !== undefined && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
    const requestBody =
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body);
    const measurement = {
      call: apiCalls,
      method,
      path: url.pathname,
      requestBytes:
        typeof requestBody === "string"
          ? Buffer.byteLength(requestBody, "utf8")
          : requestBody === undefined
            ? 0
            : null,
      responseBytes: 0,
      status: null,
      ok: false,
    };
    payloadMeasurements.push(measurement);
    let response;
    try {
      response = await fetchImplementation(url, {
        method,
        headers,
        body: requestBody,
      });
    } catch (error) {
      measurement.error = error?.message ?? String(error);
      throw error;
    }
    measurement.status = response.status;
    measurement.ok = response.ok;
    if (raw && response.ok) {
      measurement.responseBytes = (
        await response.clone().arrayBuffer()
      ).byteLength;
      return response;
    }

    const { value: responseBody, bytes: responseBytes } =
      await readResponseBody(response);
    measurement.responseBytes = responseBytes;
    if (!response.ok) {
      throw new KintoneError(
        `kintone API ${method} ${url.pathname} が HTTP ${response.status} を返しました。`,
        {
          status: response.status,
          code: responseBody?.code,
          response: responseBody,
        },
      );
    }
    return responseBody;
  }

  return {
    request,
    get apiCalls() {
      return apiCalls;
    },
    resetApiCalls() {
      apiCalls = 0;
      payloadMeasurements.length = 0;
    },
    get payloadMeasurements() {
      return payloadMeasurements.map((entry) => ({ ...entry }));
    },
    get payloadTotals() {
      return payloadMeasurements.reduce(
        (totals, entry) => ({
          requestBytes: totals.requestBytes + (entry.requestBytes ?? 0),
          responseBytes: totals.responseBytes + entry.responseBytes,
          unmeasuredRequestBodies:
            totals.unmeasuredRequestBodies +
            (entry.requestBytes === null ? 1 : 0),
        }),
        { requestBytes: 0, responseBytes: 0, unmeasuredRequestBodies: 0 },
      );
    },
  };
}

async function readResponseBody(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = Buffer.from(bytes).toString("utf8");
  const contentType = response.headers.get("content-type") ?? "";
  if (!text) return { value: null, bytes: bytes.byteLength };
  if (contentType.includes("application/json")) {
    return { value: JSON.parse(text), bytes: bytes.byteLength };
  }
  try {
    return { value: JSON.parse(text), bytes: bytes.byteLength };
  } catch {
    return { value: { message: text }, bytes: bytes.byteLength };
  }
}

export function field(value) {
  return { value: String(value) };
}

const UNIQUE_KEY_FIELD_CODES = [
  "record_key",
  "node_state_key",
  "attempt_key",
  "lock_key",
];

export function validateUniqueKeyFields(record) {
  for (const fieldCode of UNIQUE_KEY_FIELD_CODES) {
    const value = record?.[fieldCode]?.value;
    if (value === undefined || value === null || value === "") continue;
    const length = Array.from(String(value)).length;
    if (length > 64) {
      throw new Error(
        `一意キーフィールド ${fieldCode} は64文字以内で指定してください（現在${length}文字）。`,
      );
    }
  }
}

export async function insertRecord(client, app, record) {
  validateUniqueKeyFields(record);
  return client.request("record", { method: "POST", body: { app, record } });
}

export async function updateRecord(client, app, id, revision, record) {
  validateUniqueKeyFields(record);
  return client.request("record", {
    method: "PUT",
    body: { app, id, revision, record },
  });
}

export async function deleteRecord(client, app, id, revision) {
  return client.request("records", {
    method: "DELETE",
    body: { app, ids: [String(id)], revisions: [String(revision)] },
  });
}

export async function getRecordsByKey(client, app, key) {
  const escaped = key.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const response = await client.request("records", {
    query: { app, query: `record_key = "${escaped}" order by $id asc` },
  });
  return response.records ?? [];
}

export function summarizeError(error) {
  if (error instanceof KintoneError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return { status: null, code: null, message: error?.message ?? String(error) };
}
