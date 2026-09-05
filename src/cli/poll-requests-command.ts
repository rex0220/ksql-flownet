import { hostname } from "node:os";

import { FlownetChildClient } from "../requests/flownet-child-client.js";
import { KintoneRequestStore } from "../requests/kintone-request-store.js";
import {
  DEFAULT_REQUEST_HEARTBEAT_INTERVAL_MS,
  DEFAULT_REQUEST_STALE_AFTER_MS,
  loadPollRequestsConfig,
} from "../requests/poll-requests-config.js";
import {
  pollRequests,
  type RequestPollerDependencies,
} from "../requests/request-poller.js";
import { requiredEnvironment } from "./resolve-node-command.js";

export async function runPollRequestsCommand(
  args: readonly string[],
  dependencies?: RequestPollerDependencies,
): Promise<number> {
  const checkOnly = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !checkOnly) {
    process.stderr.write(
      "Invalid poll-requests arguments: only --check is accepted.\n",
    );
    return 1;
  }
  try {
    const resolvedDependencies = dependencies ?? productionDependencies();
    if (checkOnly) {
      await resolvedDependencies.store.listRequested();
      process.stdout.write(
        `poll-requests check: ok networks=${resolvedDependencies.config.networks.length} request_app=readable\n`,
      );
      return 0;
    }
    const summary = await pollRequests(resolvedDependencies);
    process.stdout.write(
      `poll-requests: requested=${summary.requested} claimed=${summary.claimed} completed=${summary.completed} cancelled=${summary.cancelled} invalid=${summary.invalid} stale=${summary.stale} skipped=${summary.skippedMalformed}\n`,
    );
    return 0;
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error [${code}]: ${message}\n`);
    return 1;
  }
}

function productionDependencies(): RequestPollerDependencies {
  const baseUrl = requiredEnvironment("KSQL_FLOWNET_BASE_URL").replace(
    /\/$/u,
    "",
  );
  const appId = positiveIntegerEnvironment("KSQL_FLOWNET_REQUEST_APP_ID");
  const apiToken = requiredEnvironment("KSQL_FLOWNET_REQUEST_API_TOKEN");
  const heartbeatIntervalMs = integerEnvironment(
    "KSQL_FLOWNET_REQUEST_HEARTBEAT_INTERVAL_MS",
    DEFAULT_REQUEST_HEARTBEAT_INTERVAL_MS,
  );
  const staleAfterMs = integerEnvironment(
    "KSQL_FLOWNET_REQUEST_STALE_AFTER_MS",
    DEFAULT_REQUEST_STALE_AFTER_MS,
  );
  const config = loadPollRequestsConfig(
    requiredEnvironment("KSQL_FLOWNET_REQUEST_ALLOWLIST_PATH"),
    { heartbeatIntervalMs, staleAfterMs },
  );
  return {
    store: new KintoneRequestStore({ baseUrl, appId, apiToken }),
    child: new FlownetChildClient({
      profile: requiredEnvironment("KSQL_FLOWNET_PROFILE"),
    }),
    config,
    host: process.env.KSQL_FLOWNET_HOST ?? hostname(),
    log(code, detail) {
      process.stderr.write(`Warning [${code}]: ${detail}\n`);
    },
  };
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "POLL_REQUESTS_FAILED";
}
