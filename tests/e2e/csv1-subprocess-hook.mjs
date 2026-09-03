import { writeFileSync } from "node:fs";

const isRun =
  process.argv.includes("run") && process.argv.includes("--result-json");
const memoryFile = process.env.CSV1_HOOK_MEMORY_FILE;
const targetAppId = Number(process.env.CSV1_HOOK_TARGET_APP_ID);
const failAfter = Number(process.env.CSV1_HOOK_FAIL_AFTER_TARGET_WRITES || 0);

if (isRun && memoryFile) {
  const peak = { ...process.memoryUsage() };
  const sample = () => {
    const current = process.memoryUsage();
    for (const key of Object.keys(peak))
      peak[key] = Math.max(peak[key], current[key]);
  };
  const timer = globalThis.setInterval(sample, 10);
  timer.unref();
  process.once("exit", () => {
    sample();
    writeFileSync(
      memoryFile,
      `${JSON.stringify({ kind: "CSV1_PROCESS_MEMORY_PEAK", sampleIntervalMs: 10, peak })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  });
}

if (
  isRun &&
  Number.isSafeInteger(targetAppId) &&
  targetAppId > 0 &&
  failAfter > 0
) {
  const originalFetch = globalThis.fetch;
  let targetWrites = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new globalThis.URL(
      typeof input === "string" || input instanceof globalThis.URL
        ? input
        : input.url,
    );
    const method = String(init.method ?? input?.method ?? "GET").toUpperCase();
    if (
      /\/k\/v1\/records\.json$/iu.test(url.pathname) &&
      (method === "POST" || method === "PUT")
    ) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (Number(body?.app) === targetAppId) {
        targetWrites += 1;
        if (targetWrites > failAfter)
          return new Response(
            JSON.stringify({
              code: "CSV1_FAULT",
              message: "CSV1 deterministic second-chunk failure",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
      }
    }
    return originalFetch(input, init);
  };
}
