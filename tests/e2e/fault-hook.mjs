import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFaultFetch } from "./fault-hook-core.mjs";

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

  globalThis.fetch = createFaultFetch({
    originalFetch,
    controlFile,
    logFile,
    targetHost,
  });
}
