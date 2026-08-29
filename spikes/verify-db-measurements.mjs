import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = new URL("../", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const readJson = (relativePath) =>
  JSON.parse(readFileSync(join(root, relativePath), "utf8"));
const readText = (relativePath) =>
  readFileSync(join(root, relativePath), "utf8");

const dFiles = [
  "spikes/d-lock-contract/results/2026-08-29T10-43-16.516Z-lock-contention.json",
  "spikes/d-lock-contract/results/2026-08-29T10-52-31.819Z-lock-contention.json",
  "spikes/d-lock-contract/results/2026-08-29T10-52-32.766Z-response-loss.json",
  "spikes/d-lock-contract/results/2026-08-29T10-52-34.357Z-revision-conflict.json",
  "spikes/d-lock-contract/results/2026-08-29T10-52-35.719Z-stale-reclaim.json",
  "spikes/d-lock-contract/results/2026-08-29T11-05-59.901Z-lock-contention.json",
];
const bFiles = [
  "spikes/b-bundle/results/2026-08-29T11-04-00.864Z-bundle-roundtrip.json",
  "spikes/b-bundle/results/2026-08-29T11-04-03.307Z-bundle-corruption.json",
];
const dResults = dFiles.map(readJson);
const bResults = bFiles.map(readJson);
const dMeasurements = readText("spikes/d-lock-contract/measurements.md");
const bMeasurements = readText("spikes/b-bundle/measurements.md");
const dDecision = readText("spikes/d-lock-contract/decision-template.md");
const bDecision = readText("spikes/b-bundle/decision-template.md");
const proposal = readText("spikes/fdr-update-proposal-2026-08-29.md");

const checks = [];
const check = (label, condition) =>
  checks.push({ label, condition: Boolean(condition) });
const hasAll = (text, values) =>
  values.every((value) => text.includes(String(value)));
const fixed = (value) =>
  Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });

for (const result of [...dResults, ...bResults]) {
  check(
    `${result.scenario}: environment`,
    result.host === "LAPTOP5" &&
      result.platform === "win32" &&
      result.nodeVersion === "v24.14.0" &&
      result.app === "4257",
  );
}
check(
  "D measurements: all source filenames",
  hasAll(
    dMeasurements,
    dFiles.map((file) => basename(file)),
  ),
);
check(
  "B measurements: all source filenames",
  hasAll(
    bMeasurements,
    bFiles.map((file) => basename(file)),
  ),
);

const contention = dResults.filter(
  (result) => result.scenario === "lock-contention",
);
for (const result of contention) {
  const duration = result.results.reduce(
    (sum, item) => sum + item.durationMs,
    0,
  );
  const workers = result.results.flatMap((item) => item.workers);
  const successes = workers.filter((worker) => worker.status === 200).length;
  const conflicts = workers.filter(
    (worker) => worker.status === 400 && worker.code === "CB_VA01",
  ).length;
  const duplicates = result.results.reduce(
    (sum, item) => sum + item.duplicateCount,
    0,
  );
  check(
    `${basename(dFiles[dResults.indexOf(result)])}: contention values`,
    hasAll(dMeasurements, [
      `${result.apiCalls}回`,
      `${fixed(duration)} ms`,
      `200 × ${successes}`,
      `400 \`CB_VA01\` × ${conflicts}`,
      `永続重複${duplicates}`,
    ]),
  );
}

const responseLoss = dResults.find(
  (result) => result.scenario === "response-loss",
);
check(
  "response-loss values",
  hasAll(dMeasurements, [
    `${responseLoss.apiCalls}回`,
    `${fixed(responseLoss.durationMs)} ms`,
    responseLoss.verdict,
    `count=${responseLoss.reget.count}`,
  ]),
);
const revision = dResults.find(
  (result) => result.scenario === "revision-conflict",
);
check(
  "revision-conflict values",
  hasAll(dMeasurements, [
    `${revision.apiCalls}回`,
    `${fixed(revision.actors[0].durationMs)} ms`,
    `${fixed(revision.actors[1].durationMs)} ms`,
    `${revision.actors[1].status} \`${revision.actors[1].code}\``,
  ]),
);
const stale = dResults.find(
  (result) => result.scenario === "stale-reclaim-old-holder-return",
);
check(
  "stale-reclaim values",
  hasAll(dMeasurements, [
    `${stale.apiCalls}回`,
    `${stale.oldHolderAttempt.status} \`${stale.oldHolderAttempt.code}\``,
    `revision ${stale.oldRevision}`,
    `revision ${stale.reclaimRevision}`,
  ]),
);

const roundtrip = bResults.find(
  (result) => result.scenario === "bundle-roundtrip",
);
for (const item of roundtrip.results) {
  check(
    `bundle ${item.label} values`,
    hasAll(bMeasurements, [
      `${item.apiCalls}回`,
      Number(item.payloadBytes).toLocaleString("en-US"),
      Number(item.zipBytes).toLocaleString("en-US"),
      ...Object.values(item.timingsMs).map((value) => `${fixed(value)} ms`),
    ]),
  );
}
const corruption = bResults.find(
  (result) => result.scenario === "bundle-corruption",
);
check(
  "bundle corruption values",
  hasAll(bMeasurements, [
    `${corruption.apiCalls}回`,
    Number(corruption.zipBytes).toLocaleString("en-US"),
    corruption.verdict,
  ]),
);
check(
  "10MiB decision exact timings",
  hasAll(bDecision, [
    `${fixed(roundtrip.results[2].timingsMs.upload)} ms`,
    `${fixed(roundtrip.results[2].timingsMs.download)} ms`,
  ]),
);
check(
  "D decision references measured verdicts",
  hasAll(dDecision, [
    responseLoss.verdict,
    revision.actors[1].code,
    stale.oldHolderAttempt.code,
  ]),
);
check(
  "FDR proposal exact measured values",
  hasAll(proposal, [
    `${fixed(roundtrip.results[2].timingsMs.upload)} ms`,
    `${fixed(roundtrip.results[2].timingsMs.download)} ms`,
    `${fixed(responseLoss.durationMs)} ms`,
    corruption.verdict,
  ]),
);

const mismatches = checks.filter((item) => !item.condition);
for (const mismatch of mismatches) console.error(`MISMATCH: ${mismatch.label}`);
console.log(
  `measurement checks: ${checks.length}, mismatches: ${mismatches.length}`,
);
if (mismatches.length > 0) process.exitCode = 1;
