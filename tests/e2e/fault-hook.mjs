import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedCli = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/cli/index.js",
);
const actualCli = process.argv[1] ? resolve(process.argv[1]) : "";
const isFlowNet =
  process.platform === "win32"
    ? actualCli.toLowerCase() === expectedCli.toLowerCase()
    : actualCli === expectedCli;

if (isFlowNet) {
  const originalFetch = globalThis.fetch;
  const controlFile = process.env.M7_FAULT_CONTROL_FILE;
  const logFile = process.env.M7_FAULT_LOG_FILE;
  const baseUrl = process.env.KSQL_FLOWNET_BASE_URL;
  const targetHost = baseUrl ? new globalThis.URL(baseUrl).host : null;

  if (!controlFile || !logFile || !targetHost)
    throw new Error(
      "M7 fault hook requires M7_FAULT_CONTROL_FILE, M7_FAULT_LOG_FILE, and KSQL_FLOWNET_BASE_URL",
    );

  globalThis.fetch = async function m7FaultFetch(input, init = {}) {
    const request = input instanceof globalThis.Request ? input : null;
    const url = new globalThis.URL(request?.url ?? input);
    const method = String(
      init.method ?? request?.method ?? "GET",
    ).toUpperCase();
    const mode = readControlMode(controlFile);
    const targeted = url.host === targetHost;
    const blocked =
      targeted &&
      (mode === "block" || (mode === "block-writes" && method !== "GET"));
    const heartbeat =
      targeted && method === "PUT" && isHeartbeatBody(init.body);

    appendFileSync(
      logFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method,
        path: url.pathname,
        targeted,
        blocked,
        heartbeat,
      })}\n`,
      "utf8",
    );

    if (blocked) {
      throw new TypeError("fetch failed", {
        cause: new Error("M7 injected kintone network interruption"),
      });
    }
    return originalFetch(input, init);
  };
}

function readControlMode(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return ["pass", "block", "block-writes"].includes(value) ? value : "pass";
  } catch (error) {
    if (error?.code === "ENOENT") return "pass";
    throw error;
  }
}

function isHeartbeatBody(body) {
  if (typeof body !== "string") return false;
  try {
    const value = JSON.parse(body);
    return Object.hasOwn(value?.record ?? {}, "heartbeat_at");
  } catch {
    return false;
  }
}
