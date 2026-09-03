import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface IoConfig {
  readonly root: string;
  readonly retentionDays: number;
}

export function loadIoConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IoConfig {
  const configuredRoot = environment.KSQL_FLOWNET_IO_DIR;
  if (configuredRoot === undefined || configuredRoot.trim() === "") {
    throw new Error("KSQL_FLOWNET_IO_DIR is required for networks with inputs");
  }
  if (!isAbsolute(configuredRoot)) {
    throw new Error("KSQL_FLOWNET_IO_DIR must be an absolute path");
  }
  const root = resolve(configuredRoot);
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    throw new Error("KSQL_FLOWNET_IO_DIR must be an existing directory", {
      cause: error,
    });
  }
  if (!stat.isDirectory()) {
    throw new Error("KSQL_FLOWNET_IO_DIR must be an existing directory");
  }

  const rawRetention = environment.KSQL_FLOWNET_IO_RETENTION_DAYS;
  const retentionDays =
    rawRetention === undefined || rawRetention.trim() === ""
      ? 90
      : Number(rawRetention);
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(
      "KSQL_FLOWNET_IO_RETENTION_DAYS must be a positive integer",
    );
  }
  return { root, retentionDays };
}
