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
    const response = await fetchImplementation(url, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (raw && response.ok) return response;

    const responseBody = await readResponseBody(response);
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
    },
  };
}

async function readResponseBody(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function field(value) {
  return { value: String(value) };
}

export async function insertRecord(client, app, record) {
  return client.request("record", { method: "POST", body: { app, record } });
}

export async function updateRecord(client, app, id, revision, record) {
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
