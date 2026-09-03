import { spawn as nodeSpawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface RunRequest {
  readonly sqlPath: string;
  readonly profile: string;
  readonly configPath: string;
  readonly asOf: string;
  readonly correlationId: string;
  readonly attemptId: string;
  readonly expectedJobId: string;
  readonly imports?: readonly RunImport[];
}

export interface RunImport {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly launchFailureConfirmed?: boolean;
  readonly launchError?: string;
}

export interface SpawnHandle {
  readonly completion: Promise<ProcessExit>;
  gracefulStop(): void | Promise<void>;
  forceStop(): void | Promise<void>;
}

export interface SpawnRunRequest {
  readonly command: string;
  readonly args: readonly string[];
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
}

export type RunSpawn = (request: SpawnRunRequest) => SpawnHandle;

export interface RunSubprocessOptions {
  readonly command: string;
  readonly binArgs?: readonly string[];
  readonly executionDirectory: string;
  readonly timeoutMs: number | null;
  readonly gracePeriodMs: number;
  readonly forcedExitWaitMs?: number;
  readonly spawn?: RunSpawn;
}

export interface SubprocessRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly resultJsonPath: string;
  readonly timedOut: boolean;
  readonly forced: boolean;
  readonly launchFailureConfirmed: boolean;
}

export class RunSubprocess {
  private readonly spawn: RunSpawn;

  constructor(private readonly options: RunSubprocessOptions) {
    if (!isAbsolute(options.executionDirectory))
      throw new Error("executionDirectory must be absolute");
    if (
      (options.timeoutMs !== null &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) ||
      !Number.isFinite(options.gracePeriodMs) ||
      options.gracePeriodMs < 0
    )
      throw new Error("timeoutMs and gracePeriodMs must be non-negative");
    this.spawn = options.spawn ?? spawnRunProcess;
  }

  async run(request: RunRequest): Promise<SubprocessRunResult> {
    if (!isAbsolute(request.sqlPath))
      throw new Error("sqlPath must be absolute");
    for (const [name, value] of [
      ["correlationId", request.correlationId],
      ["attemptId", request.attemptId],
      ["expectedJobId", request.expectedJobId],
    ] as const)
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value))
        throw new Error(`${name} must match ^[A-Za-z0-9._:-]{1,128}$`);
    const metadataDirectory = join(
      resolve(this.options.executionDirectory),
      "metadata",
    );
    await mkdir(metadataDirectory, { recursive: true });
    const resultJsonPath = join(
      metadataDirectory,
      `${safeSegment(request.attemptId)}.json`,
    );
    const contractArgs = [
      "run",
      "-f",
      request.sqlPath,
      "--profile",
      request.profile,
      "--config",
      request.configPath,
      "--as-of",
      request.asOf,
      "--result-json",
      resultJsonPath,
      "--correlation-id",
      request.correlationId,
      "--attempt-id",
      request.attemptId,
      "--expected-job-id",
      request.expectedJobId,
    ];
    for (const input of [...(request.imports ?? [])].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (
        input.name.length === 0 ||
        input.name.includes(":") ||
        input.name.includes("=") ||
        [...input.name].some((character) => {
          const code = character.codePointAt(0)!;
          return code <= 0x1f || code === 0x7f;
        }) ||
        !isAbsolute(input.path) ||
        !/^[a-f0-9]{64}$/u.test(input.sha256)
      ) {
        throw new Error(
          "import source must have a safe name, absolute path, and SHA-256",
        );
      }
      contractArgs.push(
        "--import-csv",
        `${input.name}=${input.path}`,
        "--expected-import-sha256",
        `${input.name}=${input.sha256}`,
      );
    }
    const args = [...(this.options.binArgs ?? []), ...contractArgs];
    let stdout = "";
    let stderr = "";
    let handle: SpawnHandle;
    try {
      handle = this.spawn({
        command: this.options.command,
        args,
        onStdout: (chunk) => (stdout += chunk),
        onStderr: (chunk) => (stderr += chunk),
      });
    } catch (error) {
      return {
        exitCode: null,
        stdout,
        stderr: `${stderr}${diagnostic(error)}`,
        resultJsonPath,
        timedOut: false,
        forced: false,
        launchFailureConfirmed: true,
      };
    }

    const first =
      this.options.timeoutMs === null
        ? await handle.completion
        : await raceExit(handle.completion, this.options.timeoutMs);
    if (first)
      return completed(first, stdout, stderr, resultJsonPath, false, false);

    await handle.gracefulStop();
    const graceful = await raceExit(
      handle.completion,
      this.options.gracePeriodMs,
    );
    if (graceful)
      return completed(graceful, stdout, stderr, resultJsonPath, true, false);

    await handle.forceStop();
    const forced = await raceExit(
      handle.completion,
      this.options.forcedExitWaitMs ?? this.options.gracePeriodMs,
    );
    return completed(
      forced ?? { exitCode: null },
      stdout,
      stderr,
      resultJsonPath,
      true,
      true,
    );
  }
}

export const spawnRunProcess: RunSpawn = (request) => {
  const child = nodeSpawn(request.command, request.args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", request.onStdout);
  child.stderr.on("data", request.onStderr);
  const completion = new Promise<ProcessExit>((resolveCompletion) => {
    child.once("error", (error) =>
      resolveCompletion({
        exitCode: null,
        launchFailureConfirmed: true,
        launchError: diagnostic(error),
      }),
    );
    child.once("close", (exitCode) => resolveCompletion({ exitCode }));
  });
  return {
    completion,
    gracefulStop: () => {
      child.kill(process.platform === "win32" ? "SIGINT" : "SIGTERM");
    },
    forceStop: () => {
      child.kill("SIGKILL");
    },
  };
};

function completed(
  exit: ProcessExit,
  stdout: string,
  stderr: string,
  resultJsonPath: string,
  timedOut: boolean,
  forced: boolean,
): SubprocessRunResult {
  return {
    ...exit,
    stdout,
    stderr: `${stderr}${exit.launchError ?? ""}`,
    resultJsonPath,
    timedOut,
    forced,
    launchFailureConfirmed: exit.launchFailureConfirmed === true,
  };
}

function raceExit(
  completion: Promise<ProcessExit>,
  timeoutMs: number,
): Promise<ProcessExit | null> {
  return new Promise((resolveRace, reject) => {
    const timer = setTimeout(() => resolveRace(null), timeoutMs);
    completion.then(
      (result) => {
        clearTimeout(timer);
        resolveRace(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
