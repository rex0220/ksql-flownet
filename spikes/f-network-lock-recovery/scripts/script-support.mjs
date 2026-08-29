import { isMain, makeRunMetadata, writeResult } from "../../lib/runtime.mjs";
import { requireSpikeFEnvironment, spikeFSecrets } from "./environment.mjs";

export function optionValue(arguments_, name, defaultValue) {
  const index = arguments_.indexOf(name);
  if (index === -1) return defaultValue;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} の値を指定してください。`);
  }
  return value;
}

export function positiveIntegerOption(arguments_, name, defaultValue) {
  const raw = optionValue(arguments_, name, String(defaultValue));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} は正の整数で指定してください。`);
  }
  return value;
}

export function runSpikeMain(importMetaUrl, measurementIds, run) {
  if (!isMain(importMetaUrl)) return;
  Promise.resolve()
    .then(async () => {
      const config = requireSpikeFEnvironment();
      const result = await run({ config, arguments_: process.argv.slice(2) });
      const complete = { ...makeRunMetadata(measurementIds), ...result };
      const path = await writeResult(
        importMetaUrl,
        complete,
        spikeFSecrets(config),
      );
      console.log(`測定結果を保存しました: ${path}`);
      if (!complete.passed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
