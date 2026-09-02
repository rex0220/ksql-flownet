import { isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";

import { parseDocument } from "yaml";

import { validateNetworkPath } from "../domain/validate-network-path.js";

export const DEFAULT_REQUEST_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_REQUEST_STALE_AFTER_MS = 15 * 60_000;
export const KINTONE_DATETIME_PRECISION_ALLOWANCE_MS = 60_000;

export interface PollRequestsNetwork {
  readonly networkId: string;
  readonly definitionPath: string;
  readonly appStart: boolean;
}

export interface PollRequestsConfig {
  readonly networks: readonly PollRequestsNetwork[];
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
  readonly stalePrecisionAllowanceMs: number;
}

export interface LoadPollRequestsConfigOptions {
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
}

export class PollRequestsConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PollRequestsConfigError";
    this.code = code;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PollRequestsConfigError(
      "THRESHOLD_INVALID",
      `${name} must be a positive integer`,
    );
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PollRequestsConfigError(
      "CONFIG_SHAPE_INVALID",
      "allowlist root must be an object",
    );
  }
  return value as Record<string, unknown>;
}

export function loadPollRequestsConfig(
  allowlistPath: string,
  options: LoadPollRequestsConfigOptions = {},
): PollRequestsConfig {
  if (!isAbsolute(allowlistPath)) {
    throw new PollRequestsConfigError(
      "ALLOWLIST_PATH_NOT_ABSOLUTE",
      "allowlist path must be absolute",
    );
  }
  let source: string;
  try {
    source = readFileSync(allowlistPath, "utf8");
  } catch (error) {
    throw new PollRequestsConfigError(
      "ALLOWLIST_UNREADABLE",
      "allowlist file cannot be read",
      error,
    );
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new PollRequestsConfigError(
      "ALLOWLIST_PARSE_ERROR",
      `invalid allowlist: ${document.errors[0]?.message ?? "parse error"}`,
    );
  }
  const root = objectValue(document.toJS());
  if (
    !Array.isArray(root.networks) ||
    root.networks.length === 0 ||
    Object.keys(root).some((key) => key !== "networks")
  ) {
    throw new PollRequestsConfigError(
      "CONFIG_SHAPE_INVALID",
      "allowlist must contain only a non-empty networks array",
    );
  }

  const seen = new Set<string>();
  const networks = root.networks.map((entry, index): PollRequestsNetwork => {
    const item = objectValue(entry);
    if (
      Object.keys(item).some(
        (key) =>
          key !== "network_id" &&
          key !== "definition_path" &&
          key !== "app_start",
      ) ||
      typeof item.network_id !== "string" ||
      item.network_id.trim() === "" ||
      typeof item.definition_path !== "string" ||
      item.definition_path.trim() === "" ||
      (item.app_start !== undefined && typeof item.app_start !== "boolean")
    ) {
      throw new PollRequestsConfigError(
        "NETWORK_ENTRY_INVALID",
        `networks[${index}] must contain network_id and definition_path`,
      );
    }
    if (seen.has(item.network_id)) {
      throw new PollRequestsConfigError(
        "DUPLICATE_NETWORK",
        `duplicate network_id: ${item.network_id}`,
      );
    }
    seen.add(item.network_id);
    if (!isAbsolute(item.definition_path)) {
      throw new PollRequestsConfigError(
        "DEFINITION_PATH_NOT_ABSOLUTE",
        `definition path for ${item.network_id} must be absolute`,
      );
    }
    const definitionPath = resolve(item.definition_path);
    const loaded = validateNetworkPath(definitionPath);
    if (loaded.definition === undefined || loaded.errors.length > 0) {
      throw new PollRequestsConfigError(
        "NETWORK_DEFINITION_INVALID",
        `network definition for ${item.network_id} is unavailable or invalid`,
      );
    }
    if (loaded.definition.network_id !== item.network_id) {
      throw new PollRequestsConfigError(
        "NETWORK_ID_MISMATCH",
        `allowlist network_id does not match definition: ${item.network_id}`,
      );
    }
    return {
      networkId: item.network_id,
      definitionPath,
      appStart: item.app_start === true,
    };
  });

  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs ?? DEFAULT_REQUEST_HEARTBEAT_INTERVAL_MS,
    "heartbeatIntervalMs",
  );
  const staleAfterMs = positiveInteger(
    options.staleAfterMs ?? DEFAULT_REQUEST_STALE_AFTER_MS,
    "staleAfterMs",
  );
  if (staleAfterMs <= heartbeatIntervalMs) {
    throw new PollRequestsConfigError(
      "THRESHOLD_INVALID",
      "staleAfterMs must be greater than heartbeatIntervalMs",
    );
  }
  return {
    networks,
    heartbeatIntervalMs,
    staleAfterMs,
    stalePrecisionAllowanceMs: KINTONE_DATETIME_PRECISION_ALLOWANCE_MS,
  };
}

export function definitionPathForNetwork(
  config: PollRequestsConfig,
  networkId: string,
): string {
  return networkForNetworkId(config, networkId).definitionPath;
}

export function networkForNetworkId(
  config: PollRequestsConfig,
  networkId: string,
): PollRequestsNetwork {
  const match = config.networks.find(
    (network) => network.networkId === networkId,
  );
  if (match === undefined) {
    throw new PollRequestsConfigError(
      "NETWORK_NOT_ALLOWED",
      `network is not in the allowlist: ${networkId}`,
    );
  }
  return match;
}
