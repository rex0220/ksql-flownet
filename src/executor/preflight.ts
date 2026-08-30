import { createHash } from "node:crypto";

import type { NetworkNodeDefinition } from "../domain/network-definition.js";
import type {
  CapabilitiesResult,
  JobInspection,
  ProfileDescription,
} from "./ksql-flow-cli.js";

export const EXECUTION_CONTRACT = "ksql-flow.execution/v1";
export const REQUIRED_CAPABILITY_FEATURES = [
  "resultJson",
  "correlationIds",
  "describeProfile",
  "inspectJob",
  "durableExecutionStarted",
] as const;
export const NONDETERMINISTIC_CODES = ["KSQL1306"] as const;

export interface ApprovedInspectionException {
  readonly node_id: string;
  readonly code: (typeof NONDETERMINISTIC_CODES)[number];
  readonly approved_by: string;
  readonly reason: string;
  readonly approved_at: string;
}

export interface ProfileSnapshot {
  readonly canonicalJsonSha256: string;
  readonly baseUrl: string;
  readonly guestSpaceId: number | null;
  readonly apps: Readonly<Record<string, number>>;
  readonly timezone: string | null;
}

export interface InspectedNode {
  readonly nodeId: string;
  readonly jobId: string;
  readonly inspection: JobInspection;
  readonly nondeterministicCodes: readonly string[];
  readonly approvedExceptions: readonly ApprovedInspectionException[];
}

export type PreflightErrorCode =
  | "CAPABILITY_CONTRACT_MISSING"
  | "CAPABILITY_FEATURE_MISSING"
  | "PROFILE_SNAPSHOT_MISMATCH"
  | "JOB_ID_MISMATCH"
  | "NONDETERMINISTIC_IDEMPOTENT_JOB"
  | "INSPECTION_EXCEPTION_INVALID"
  | "INSPECTION_EXCEPTION_NOT_DETECTED";

export class PreflightError extends Error {
  constructor(
    readonly code: PreflightErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

export function validateCapabilities(capabilities: CapabilitiesResult): void {
  if (!capabilities.executionContracts.includes(EXECUTION_CONTRACT)) {
    throw new PreflightError(
      "CAPABILITY_CONTRACT_MISSING",
      `required execution contract '${EXECUTION_CONTRACT}' is not supported`,
    );
  }
  const missing = REQUIRED_CAPABILITY_FEATURES.filter(
    (feature) => capabilities.features[feature] !== true,
  );
  if (missing.length > 0) {
    throw new PreflightError(
      "CAPABILITY_FEATURE_MISSING",
      `required capability features are not true: ${missing.join(", ")}`,
      missing,
    );
  }
}

/** All object keys are sorted recursively; array order remains significant. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonKeys(value));
  if (serialized === undefined) {
    throw new TypeError("value cannot be represented as canonical JSON");
  }
  return serialized;
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

export function profileSnapshot(
  description: ProfileDescription,
): ProfileSnapshot {
  return {
    canonicalJsonSha256: canonicalJsonSha256(description),
    baseUrl: description.baseUrl,
    guestSpaceId: description.guestSpaceId,
    apps: description.apps,
    timezone: description.timezone,
  };
}

export function assertProfileSnapshot(
  description: ProfileDescription,
  expected: ProfileSnapshot,
): void {
  const actual = profileSnapshot(description);
  const mismatches: string[] = [];
  if (actual.canonicalJsonSha256 !== expected.canonicalJsonSha256) {
    mismatches.push("canonicalJsonSha256");
  }
  if (actual.baseUrl !== expected.baseUrl) mismatches.push("baseUrl");
  if (actual.guestSpaceId !== expected.guestSpaceId) {
    mismatches.push("guestSpaceId");
  }
  if (actual.timezone !== expected.timezone) mismatches.push("timezone");
  if (canonicalJson(actual.apps) !== canonicalJson(expected.apps)) {
    mismatches.push("apps");
  }
  if (mismatches.length > 0) {
    throw new PreflightError(
      "PROFILE_SNAPSHOT_MISMATCH",
      `resolved profile differs from snapshot: ${mismatches.join(", ")}`,
      mismatches,
    );
  }
}

export function validateJobInspections(
  nodes: readonly NetworkNodeDefinition[],
  inspections: ReadonlyMap<string, JobInspection>,
  exceptions: readonly ApprovedInspectionException[] = [],
): readonly InspectedNode[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  validateExceptionFields(exceptions, nodesById);

  const duplicateKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const exception of exceptions) {
    const key = `${exception.node_id}\0${exception.code}`;
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);
  }
  if (duplicateKeys.size > 0) {
    throw new PreflightError(
      "INSPECTION_EXCEPTION_INVALID",
      "duplicate approved inspection exception",
    );
  }

  const result: InspectedNode[] = [];
  for (const node of nodes) {
    const inspection = inspections.get(node.id);
    if (inspection === undefined) {
      throw new PreflightError(
        "JOB_ID_MISMATCH",
        `inspection is missing for node '${node.id}'`,
        [node.id],
      );
    }
    if (inspection.jobId !== node.job_id) {
      throw new PreflightError(
        "JOB_ID_MISMATCH",
        `node '${node.id}' expects job_id '${node.job_id}', inspected '${inspection.jobId}'`,
        [node.id],
      );
    }

    // D-23 deliberately recognizes only the engine's public KSQL1306 code.
    // KSQL1305 remains a warning and static inspection does not prove idempotency.
    const detected = uniqueSorted(
      inspection.diagnostics
        .filter((diagnostic) =>
          NONDETERMINISTIC_CODES.includes(
            diagnostic.code as (typeof NONDETERMINISTIC_CODES)[number],
          ),
        )
        .map((diagnostic) => diagnostic.code),
    );
    const approved = exceptions.filter(
      (exception) => exception.node_id === node.id,
    );
    for (const exception of approved) {
      if (!detected.includes(exception.code)) {
        throw new PreflightError(
          "INSPECTION_EXCEPTION_NOT_DETECTED",
          `exception ${exception.code} for node '${node.id}' has no matching detected diagnostic`,
          [node.id, exception.code],
        );
      }
    }
    const unapproved = detected.filter(
      (code) => !approved.some((exception) => exception.code === code),
    );
    if (node.idempotent && unapproved.length > 0) {
      throw new PreflightError(
        "NONDETERMINISTIC_IDEMPOTENT_JOB",
        `idempotent node '${node.id}' has unapproved nondeterministic diagnostics: ${unapproved.join(", ")}`,
        [node.id, ...unapproved],
      );
    }
    result.push({
      nodeId: node.id,
      jobId: inspection.jobId,
      inspection,
      nondeterministicCodes: detected,
      approvedExceptions: approved,
    });
  }
  return result;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortJsonKeys(source[key]);
  }
  return sorted;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function validateExceptionFields(
  exceptions: readonly ApprovedInspectionException[],
  nodesById: ReadonlyMap<string, NetworkNodeDefinition>,
): void {
  for (const exception of exceptions) {
    const validTimestamp =
      typeof exception.approved_at === "string" &&
      Number.isFinite(Date.parse(exception.approved_at));
    if (
      !nodesById.has(exception.node_id) ||
      !NONDETERMINISTIC_CODES.includes(exception.code) ||
      exception.approved_by.trim() === "" ||
      exception.reason.trim() === "" ||
      !validTimestamp
    ) {
      throw new PreflightError(
        "INSPECTION_EXCEPTION_INVALID",
        `approved inspection exception is invalid for node '${exception.node_id}'`,
        [exception.node_id, exception.code],
      );
    }
  }
}
