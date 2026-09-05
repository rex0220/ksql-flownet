import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const CONTROL_MODES = new Set(["pass", "block", "block-writes"]);

export function readControl(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (CONTROL_MODES.has(text)) return { mode: text, barriers: [] };
    try {
      const parsed = JSON.parse(text);
      return {
        mode: CONTROL_MODES.has(parsed?.mode) ? parsed.mode : "pass",
        barriers: Array.isArray(parsed?.barriers) ? parsed.barriers : [],
      };
    } catch {
      return { mode: "pass", barriers: [] };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { mode: "pass", barriers: [] };
    throw error;
  }
}

function jsonBody(body) {
  if (typeof body !== "string") return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function matchesBarrier(barrier, request) {
  const match = barrier?.match;
  if (
    typeof barrier?.id !== "string" ||
    barrier.id.length === 0 ||
    !["before", "after-success"].includes(barrier.phase) ||
    typeof barrier.release !== "string" ||
    !isAbsolute(barrier.release) ||
    !match ||
    typeof match.path !== "string"
  ) {
    return false;
  }
  let pathMatches;
  try {
    pathMatches = new RegExp(match.path, "u").test(request.path);
  } catch {
    return false;
  }
  if (!pathMatches) return false;
  if (
    match.method !== undefined &&
    !["PUT", "POST", "GET", "DELETE"].includes(
      String(match.method).toUpperCase(),
    )
  ) {
    return false;
  }
  if (
    match.method !== undefined &&
    String(match.method).toUpperCase() !== request.method
  ) {
    return false;
  }
  const bodyMatch = match.body;
  if (bodyMatch === undefined) return true;
  if (!bodyMatch || typeof bodyMatch !== "object") return false;
  const hasBodyCondition = ["app", "id", "field"].some((name) =>
    Object.hasOwn(bodyMatch, name),
  );
  if (hasBodyCondition && !request.body) return false;
  if (
    bodyMatch.app !== undefined &&
    String(request.body.app) !== String(bodyMatch.app)
  ) {
    return false;
  }
  if (
    bodyMatch.id !== undefined &&
    String(request.body.id) !== String(bodyMatch.id)
  ) {
    return false;
  }
  if (
    bodyMatch.field !== undefined &&
    (typeof bodyMatch.field !== "string" ||
      !Object.hasOwn(request.body.record ?? {}, bodyMatch.field))
  ) {
    return false;
  }
  return true;
}

export async function waitForRelease(
  path,
  {
    fileExists = existsSync,
    sleep = (ms) =>
      new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
    now = () => Date.now(),
    intervalMs = 100,
    timeoutMs = 120_000,
  } = {},
) {
  const startedAt = now();
  while (!fileExists(path)) {
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`fault barrier release timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

export function createFaultFetch({
  originalFetch,
  controlFile,
  logFile,
  targetHost,
  appendLog = (entry) =>
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8"),
  now = () => new Date(),
  wait = waitForRelease,
} = {}) {
  if (typeof originalFetch !== "function")
    throw new TypeError("originalFetch is required");
  const fired = new Set();

  const barrierLog = (barrier, request, responseStatus) =>
    appendLog({
      at: now().toISOString(),
      barrier_id: barrier.id,
      phase: barrier.phase,
      method: request.method,
      path: request.path,
      ...(responseStatus === undefined
        ? {}
        : { response_status: responseStatus }),
    });

  return async function faultFetch(input, init = {}) {
    const request = input instanceof globalThis.Request ? input : null;
    const url = new globalThis.URL(request?.url ?? input);
    const method = String(
      init.method ?? request?.method ?? "GET",
    ).toUpperCase();
    const control = readControl(controlFile);
    const targeted = url.host === targetHost;
    const blocked =
      targeted &&
      (control.mode === "block" ||
        (control.mode === "block-writes" && method !== "GET"));
    let body = jsonBody(init.body);
    if (!body && request) {
      body = jsonBody(await request.clone().text());
    }
    const requestInfo = { method, path: url.pathname, body };
    const heartbeat =
      targeted &&
      method === "PUT" &&
      Object.hasOwn(body?.record ?? {}, "heartbeat_at");

    appendLog({
      at: now().toISOString(),
      method,
      path: url.pathname,
      targeted,
      blocked,
      heartbeat,
    });

    if (blocked) {
      throw new TypeError("fetch failed", {
        cause: new Error("M7 injected kintone network interruption"),
      });
    }

    const matching = targeted
      ? control.barriers.filter(
          (barrier) =>
            !fired.has(barrier.id) && matchesBarrier(barrier, requestInfo),
        )
      : [];
    for (const barrier of matching.filter(({ phase }) => phase === "before")) {
      if (fired.has(barrier.id)) continue;
      fired.add(barrier.id);
      barrierLog(barrier, requestInfo);
      await wait(barrier.release);
    }

    const response = await originalFetch(input, init);
    if (response.status >= 200 && response.status < 300) {
      for (const barrier of matching.filter(
        ({ phase }) => phase === "after-success",
      )) {
        if (fired.has(barrier.id)) continue;
        fired.add(barrier.id);
        barrierLog(barrier, requestInfo, response.status);
        await wait(barrier.release);
      }
    }
    return response;
  };
}
