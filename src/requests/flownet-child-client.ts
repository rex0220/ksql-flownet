import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StatusOutput } from "../orchestration/status.js";
import type { PollRequestsNetwork } from "./poll-requests-config.js";
import type { RequestRecord } from "./request-model.js";

export const DEFAULT_CHILD_OUTPUT_LIMIT = 64 * 1024;
export const REQUESTED_BY_MAX_LENGTH = 1024;

export interface ChildProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly spawnError?: string;
}

export interface RunNetworkJsonOutput {
  readonly outcome: "NEW" | "RESUME" | "NOOP" | "REJECTED";
  readonly run_id: string | null;
  readonly invocation_id: string | null;
  readonly aggregate_status: string | null;
  readonly invocation_result_code: string;
}

export interface FlownetChildClientOptions {
  readonly profile: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly outputLimit?: number;
  readonly cliPath?: string;
  readonly execute?: (
    command: string,
    args: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly shell: false },
  ) => Promise<ChildProcessResult>;
  readonly makeTempDirectory?: () => Promise<string>;
  readonly removeTempDirectory?: (path: string) => Promise<void>;
}

export class FlownetChildClient {
  private readonly profile: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly outputLimit: number;
  private readonly cliPath: string;
  private readonly executeProcess: NonNullable<
    FlownetChildClientOptions["execute"]
  >;
  private readonly makeTempDirectory: () => Promise<string>;
  private readonly removeTempDirectory: (path: string) => Promise<void>;

  constructor(options: FlownetChildClientOptions) {
    this.profile = options.profile;
    this.environment = options.environment ?? process.env;
    this.outputLimit = options.outputLimit ?? DEFAULT_CHILD_OUTPUT_LIMIT;
    if (!Number.isSafeInteger(this.outputLimit) || this.outputLimit < 1) {
      throw new RangeError("outputLimit must be a positive integer");
    }
    this.cliPath =
      options.cliPath ??
      fileURLToPath(new URL("../cli/index.js", import.meta.url));
    this.executeProcess =
      options.execute ??
      ((command, args, childOptions) =>
        executeChild(command, args, childOptions, this.outputLimit));
    this.makeTempDirectory =
      options.makeTempDirectory ??
      (() => mkdtemp(join(tmpdir(), "ksql-flownet-request-")));
    this.removeTempDirectory =
      options.removeTempDirectory ??
      ((path) => rm(path, { recursive: true, force: true }));
  }

  async status(
    network: PollRequestsNetwork,
    runId: string,
  ): Promise<StatusOutput | null> {
    const result = await this.run(
      [
        "status",
        network.networkId,
        "--profile",
        this.profile,
        "--run-id",
        runId,
        "--json",
      ],
      undefined,
    );
    if (result.exitCode !== 0 || result.spawnError !== undefined) {
      if (
        result.spawnError === undefined &&
        /^Error \[RECORD_NOT_FOUND\]:/u.test(result.stderr)
      ) {
        return null;
      }
      throw new ChildClientError(
        "STATUS_CHILD_FAILED",
        "status child failed",
        result,
      );
    }
    try {
      return JSON.parse(result.stdout) as StatusOutput;
    } catch (error) {
      throw new ChildClientError(
        "STATUS_JSON_INVALID",
        "status child returned invalid JSON",
        result,
        error,
      );
    }
  }

  async runNetwork(
    network: PollRequestsNetwork,
    request: RequestRecord,
  ): Promise<{
    readonly output: RunNetworkJsonOutput | null;
    readonly process: ChildProcessResult;
  }> {
    const args = [
      "run-network",
      network.definitionPath,
      "--resume-run",
      request.runId,
      ...(request.rerunFromNode === null
        ? []
        : ["--rerun-from", request.rerunFromNode]),
      "--json",
    ];
    const processResult = await this.run(args, requestedBy(request));
    let output: RunNetworkJsonOutput | null = null;
    try {
      output = JSON.parse(processResult.stdout) as RunNetworkJsonOutput;
    } catch {
      // The classifier treats an absent machine-readable result as a rejection.
    }
    return { output, process: processResult };
  }

  async cancelRun(
    request: RequestRecord,
    release: boolean,
  ): Promise<ChildProcessResult> {
    const directory = await this.makeTempDirectory();
    const reasonPath = join(directory, "reason.txt");
    try {
      await writeFile(reasonPath, request.reason, {
        encoding: "utf8",
        mode: 0o600,
      });
      return await this.run(
        [
          "cancel-run",
          "--run-id",
          request.runId,
          ...(release ? ["--release"] : []),
          "--reason-file",
          reasonPath,
        ],
        requestedBy(request),
      );
    } finally {
      await this.removeTempDirectory(directory);
    }
  }

  private run(
    args: readonly string[],
    correlation: string | undefined,
  ): Promise<ChildProcessResult> {
    const env = {
      ...this.environment,
      ...(correlation === undefined
        ? {}
        : { KSQL_FLOWNET_REQUESTED_BY: correlation }),
    };
    return this.executeProcess(process.execPath, [this.cliPath, ...args], {
      env,
      shell: false,
    });
  }
}

export class ChildClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly result: ChildProcessResult,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChildClientError";
  }
}

export function requestedBy(
  request: Pick<RequestRecord, "id" | "creatorCode">,
): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(request.creatorCode);
  } catch (error) {
    throw new RequestCorrelationError(
      "request creator cannot be percent-encoded",
      error,
    );
  }
  const value = `app-request:${request.id}:${encoded}`;
  if (value.length > REQUESTED_BY_MAX_LENGTH) {
    throw new RequestCorrelationError("request correlation value is too long");
  }
  return value;
}

export class RequestCorrelationError extends Error {
  readonly code = "REQUESTED_BY_INVALID";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RequestCorrelationError";
  }
}

export function executeChild(
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly shell: false },
  limit: number,
): Promise<ChildProcessResult> {
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let spawnError: string | undefined;
    const child = spawn(command, [...args], options);
    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, limit);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, limit);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.once("error", (error) => {
      spawnError =
        "code" in error && typeof error.code === "string"
          ? error.code
          : "SPAWN_FAILED";
    });
    child.once("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    });
  });
}

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): { readonly value: Buffer<ArrayBufferLike>; readonly truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const remaining = limit - current.length;
  return {
    value: Buffer.concat([current, chunk.subarray(0, remaining)]),
    truncated: chunk.length > remaining,
  };
}
