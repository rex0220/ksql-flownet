import { spawn } from "node:child_process";

export interface CapabilitiesResult {
  readonly formatVersion: 1;
  readonly kind: "CAPABILITIES";
  readonly ksqlFlowVersion: string;
  readonly engineVersion: string;
  readonly executionContracts: readonly string[];
  readonly resultSchema: {
    readonly $id: string;
    readonly contract: string;
  };
  readonly features: Readonly<Record<string, boolean | string>>;
}

export interface ProfileDescription {
  readonly formatVersion: 1;
  readonly kind: "PROFILE_DESCRIPTION";
  readonly profile: string;
  readonly baseUrl: string;
  readonly guestSpaceId: number | null;
  readonly timezone: string | null;
  readonly apps: Readonly<Record<string, number>>;
  readonly logApp: { readonly name: string; readonly appId: number } | null;
  readonly limits: Readonly<Record<string, number>>;
  readonly retry: Readonly<Record<string, number | boolean>>;
  readonly httpTimeoutMs: number;
}

export interface InspectionDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface JobInspection {
  readonly formatVersion: 1;
  readonly kind: "JOB_INSPECTION";
  readonly jobId: string;
  readonly fileName: string;
  readonly dialect: number;
  readonly statementCount: number;
  readonly dependsOn: readonly string[];
  readonly timeoutSec: number | null;
  readonly diagnostics: readonly InspectionDiagnostic[];
  readonly nondeterministicElements: readonly InspectionDiagnostic[];
}

export type KsqlFlowCliErrorCode =
  | "KSQL_FLOW_PROCESS_FAILED"
  | "KSQL_FLOW_INVALID_JSON"
  | "KSQL_FLOW_EXIT_MISMATCH"
  | "KSQL_FLOW_OUTPUT_INVALID";

export class KsqlFlowCliError extends Error {
  constructor(
    readonly code: KsqlFlowCliErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KsqlFlowCliError";
  }
}

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnInvoker = (request: SpawnRequest) => Promise<SpawnResult>;

export interface KsqlFlowCliOptions {
  readonly command: string;
  readonly binArgs?: readonly string[];
  readonly profile: string;
  readonly configPath: string;
  readonly spawn?: SpawnInvoker;
}

export class KsqlFlowCli {
  private readonly invokeSpawn: SpawnInvoker;

  constructor(private readonly options: KsqlFlowCliOptions) {
    this.invokeSpawn = options.spawn ?? spawnProcess;
  }

  capabilities(): Promise<CapabilitiesResult> {
    return this.invokeJson(
      ["capabilities", "--json"],
      isCapabilities,
      "CAPABILITIES",
    );
  }

  describeProfile(): Promise<ProfileDescription> {
    return this.invokeJson(
      [
        "describe-profile",
        "--profile",
        this.options.profile,
        "--config",
        this.options.configPath,
        "--json",
      ],
      isProfileDescription,
      "PROFILE_DESCRIPTION",
    );
  }

  inspectJob(sqlPath: string): Promise<JobInspection> {
    return this.invokeJson(
      [
        "inspect-job",
        "-f",
        sqlPath,
        "--profile",
        this.options.profile,
        "--config",
        this.options.configPath,
        "--json",
      ],
      isJobInspection,
      "JOB_INSPECTION",
    );
  }

  private async invokeJson<T>(
    args: readonly string[],
    validate: (value: unknown) => value is T,
    expectedKind: string,
  ): Promise<T> {
    let result: SpawnResult;
    try {
      result = await this.invokeSpawn({
        command: this.options.command,
        args: [...(this.options.binArgs ?? []), ...args],
      });
    } catch (error) {
      throw new KsqlFlowCliError(
        "KSQL_FLOW_PROCESS_FAILED",
        `kSQL-Flow process could not be started for ${args[0]}`,
        { cause: error },
      );
    }
    if (result.exitCode === null) {
      throw new KsqlFlowCliError(
        "KSQL_FLOW_PROCESS_FAILED",
        `kSQL-Flow process ended without an exit code for ${args[0]}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new KsqlFlowCliError(
        "KSQL_FLOW_EXIT_MISMATCH",
        `kSQL-Flow ${args[0]} exited with ${result.exitCode}; expected 0`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch (error) {
      throw new KsqlFlowCliError(
        "KSQL_FLOW_INVALID_JSON",
        `kSQL-Flow ${args[0]} returned invalid JSON`,
        { cause: error },
      );
    }
    if (!validate(value)) {
      throw new KsqlFlowCliError(
        "KSQL_FLOW_OUTPUT_INVALID",
        `kSQL-Flow ${args[0]} output does not match ${expectedKind} formatVersion 1`,
      );
    }
    return value;
  }
}

export const spawnProcess: SpawnInvoker = ({ command, args }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isCapabilities(value: unknown): value is CapabilitiesResult {
  if (
    !isRecord(value) ||
    !isRecord(value.resultSchema) ||
    !isRecord(value.features)
  ) {
    return false;
  }
  return (
    value.formatVersion === 1 &&
    value.kind === "CAPABILITIES" &&
    typeof value.ksqlFlowVersion === "string" &&
    typeof value.engineVersion === "string" &&
    isStringArray(value.executionContracts) &&
    typeof value.resultSchema.$id === "string" &&
    typeof value.resultSchema.contract === "string" &&
    Object.values(value.features).every(
      (feature) => typeof feature === "boolean" || typeof feature === "string",
    )
  );
}

function isProfileDescription(value: unknown): value is ProfileDescription {
  if (
    !isRecord(value) ||
    !isRecord(value.apps) ||
    !isRecord(value.limits) ||
    !isRecord(value.retry)
  ) {
    return false;
  }
  const logAppValid =
    value.logApp === null ||
    (isRecord(value.logApp) &&
      typeof value.logApp.name === "string" &&
      Number.isSafeInteger(value.logApp.appId));
  return (
    value.formatVersion === 1 &&
    value.kind === "PROFILE_DESCRIPTION" &&
    typeof value.profile === "string" &&
    typeof value.baseUrl === "string" &&
    (value.guestSpaceId === null || Number.isSafeInteger(value.guestSpaceId)) &&
    (value.timezone === null || typeof value.timezone === "string") &&
    Object.values(value.apps).every(Number.isSafeInteger) &&
    logAppValid &&
    Object.values(value.limits).every((item) => typeof item === "number") &&
    Object.values(value.retry).every(
      (item) => typeof item === "number" || typeof item === "boolean",
    ) &&
    typeof value.httpTimeoutMs === "number"
  );
}

function isDiagnostic(value: unknown): value is InspectionDiagnostic {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.severity === "string" &&
    Number.isSafeInteger(value.line) &&
    Number.isSafeInteger(value.column) &&
    typeof value.message === "string"
  );
}

function isJobInspection(value: unknown): value is JobInspection {
  return (
    isRecord(value) &&
    value.formatVersion === 1 &&
    value.kind === "JOB_INSPECTION" &&
    typeof value.jobId === "string" &&
    typeof value.fileName === "string" &&
    Number.isSafeInteger(value.dialect) &&
    Number.isSafeInteger(value.statementCount) &&
    isStringArray(value.dependsOn) &&
    (value.timeoutSec === null || Number.isSafeInteger(value.timeoutSec)) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic) &&
    Array.isArray(value.nondeterministicElements) &&
    value.nondeterministicElements.every(isDiagnostic)
  );
}
