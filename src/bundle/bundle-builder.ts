import type {
  ApprovedInspectionException,
  InspectedNode,
} from "../executor/preflight.js";
import { canonicalJson, sha256Hex } from "../executor/preflight.js";
import { createStoreZip, readStoreZip } from "./zip-store.js";

export interface BundleJobInput {
  readonly path: string;
  readonly sqlBytes: Uint8Array;
  /** Validated result returned by validateJobInspections. */
  readonly inspectedNode: InspectedNode;
}

export interface BundleFileManifest {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly nodeId?: string;
  readonly jobId?: string;
  readonly nondeterministicCodes?: readonly string[];
  readonly approvedExceptions?: readonly ApprovedInspectionException[];
}

export interface BundleManifest {
  readonly formatVersion: 1;
  readonly kind: "EXECUTION_BUNDLE_MANIFEST";
  readonly files: readonly BundleFileManifest[];
}

export interface BuildBundleInput {
  readonly networkYamlBytes: Uint8Array;
  readonly jobs: readonly BundleJobInput[];
}

export interface BuildBundleResult {
  readonly zipBytes: Buffer;
  readonly zipSha256: string;
  readonly manifest: BundleManifest;
  readonly manifestSha256: string;
}

export interface VerifyBundleExpectations {
  readonly zipSha256?: string;
  readonly manifestSha256?: string;
  readonly manifest?: BundleManifest;
}

export interface VerifyBundleResult {
  readonly zipSha256: string;
  readonly manifestSha256: string;
  readonly manifest: BundleManifest;
}

export type BundleErrorCode =
  | "BUNDLE_INPUT_INVALID"
  | "BUNDLE_ZIP_INVALID"
  | "BUNDLE_HASH_MISMATCH"
  | "BUNDLE_MANIFEST_INVALID"
  | "BUNDLE_FILE_MISMATCH";

export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BundleError";
  }
}

export function buildBundle(input: BuildBundleInput): BuildBundleResult {
  if (input.jobs.length === 0) {
    throw new BundleError(
      "BUNDLE_INPUT_INVALID",
      "execution bundle requires at least one SQL job",
    );
  }
  const sortedJobs = [...input.jobs].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const seenPaths = new Set<string>();
  const files: BundleFileManifest[] = [
    fileManifest("network.yaml", input.networkYamlBytes),
  ];
  const zipEntries: { name: string; data: Uint8Array }[] = [
    { name: "network.yaml", data: input.networkYamlBytes },
  ];

  for (const job of sortedJobs) {
    validateJobInput(job, seenPaths);
    const approvedExceptions = [...job.inspectedNode.approvedExceptions].sort(
      (left, right) =>
        compareText(exceptionSortKey(left), exceptionSortKey(right)),
    );
    files.push({
      ...fileManifest(job.path, job.sqlBytes),
      nodeId: job.inspectedNode.nodeId,
      jobId: job.inspectedNode.jobId,
      nondeterministicCodes: [
        ...new Set(job.inspectedNode.nondeterministicCodes),
      ].sort(),
      approvedExceptions,
    });
    zipEntries.push({ name: job.path, data: job.sqlBytes });
  }

  const manifest: BundleManifest = {
    formatVersion: 1,
    kind: "EXECUTION_BUNDLE_MANIFEST",
    files,
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  const zipBytes = createStoreZip([
    ...zipEntries,
    { name: "manifest.json", data: manifestBytes },
  ]);
  return {
    zipBytes,
    zipSha256: sha256Hex(zipBytes),
    manifest,
    manifestSha256: sha256Hex(manifestBytes),
  };
}

export function verifyBundle(
  zipInput: Uint8Array,
  expected: VerifyBundleExpectations = {},
): VerifyBundleResult {
  const zipBytes = Buffer.from(zipInput);
  const zipSha256 = sha256Hex(zipBytes);
  if (expected.zipSha256 !== undefined && zipSha256 !== expected.zipSha256) {
    throw new BundleError(
      "BUNDLE_HASH_MISMATCH",
      "execution bundle ZIP SHA-256 does not match",
    );
  }

  let entries: ReturnType<typeof readStoreZip>;
  try {
    entries = readStoreZip(zipBytes);
  } catch (error) {
    throw new BundleError(
      "BUNDLE_ZIP_INVALID",
      "execution bundle ZIP is invalid",
      {
        cause: error,
      },
    );
  }
  const entryMap = new Map(entries.map((entry) => [entry.name, entry.data]));
  const manifestBytes = entryMap.get("manifest.json");
  if (manifestBytes === undefined) {
    throw new BundleError(
      "BUNDLE_MANIFEST_INVALID",
      "execution bundle has no manifest.json",
    );
  }
  const manifestSha256 = sha256Hex(manifestBytes);
  if (
    expected.manifestSha256 !== undefined &&
    manifestSha256 !== expected.manifestSha256
  ) {
    throw new BundleError(
      "BUNDLE_HASH_MISMATCH",
      "execution bundle manifest SHA-256 does not match",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new BundleError(
      "BUNDLE_MANIFEST_INVALID",
      "execution bundle manifest is not valid JSON",
      { cause: error },
    );
  }
  if (!isBundleManifest(parsed)) {
    throw new BundleError(
      "BUNDLE_MANIFEST_INVALID",
      "execution bundle manifest shape is invalid",
    );
  }
  if (canonicalJson(parsed) !== manifestBytes.toString("utf8")) {
    throw new BundleError(
      "BUNDLE_MANIFEST_INVALID",
      "execution bundle manifest is not canonical JSON",
    );
  }
  if (
    expected.manifest !== undefined &&
    canonicalJson(parsed) !== canonicalJson(expected.manifest)
  ) {
    throw new BundleError(
      "BUNDLE_MANIFEST_INVALID",
      "execution bundle manifest content does not match expected manifest",
    );
  }

  const manifestPaths = new Set<string>();
  for (const file of parsed.files) {
    if (manifestPaths.has(file.path)) {
      throw new BundleError(
        "BUNDLE_MANIFEST_INVALID",
        `manifest contains duplicate path '${file.path}'`,
      );
    }
    manifestPaths.add(file.path);
    const bytes = entryMap.get(file.path);
    if (
      bytes === undefined ||
      bytes.length !== file.byteLength ||
      sha256Hex(bytes) !== file.sha256
    ) {
      throw new BundleError(
        "BUNDLE_FILE_MISMATCH",
        `bundle file '${file.path}' does not match its manifest`,
      );
    }
  }
  if (!manifestPaths.has("network.yaml")) {
    throw new BundleError(
      "BUNDLE_MANIFEST_INVALID",
      "manifest does not contain network.yaml",
    );
  }
  const unexpectedEntries = entries
    .map((entry) => entry.name)
    .filter((name) => name !== "manifest.json" && !manifestPaths.has(name));
  if (
    unexpectedEntries.length > 0 ||
    entries.length !== parsed.files.length + 1
  ) {
    throw new BundleError(
      "BUNDLE_FILE_MISMATCH",
      `bundle has entries not represented by the manifest: ${unexpectedEntries.join(", ")}`,
    );
  }
  return { zipSha256, manifestSha256, manifest: parsed };
}

function fileManifest(path: string, bytes: Uint8Array): BundleFileManifest {
  return { path, byteLength: bytes.byteLength, sha256: sha256Hex(bytes) };
}

function validateJobInput(job: BundleJobInput, seenPaths: Set<string>): void {
  if (
    !/^jobs\/[A-Za-z0-9._-]+\.sql$/u.test(job.path) ||
    job.path.includes("..") ||
    job.inspectedNode.nodeId.trim() === "" ||
    job.inspectedNode.jobId.trim() === ""
  ) {
    throw new BundleError(
      "BUNDLE_INPUT_INVALID",
      `bundle job input is invalid for '${job.path}'`,
    );
  }
  if (seenPaths.has(job.path)) {
    throw new BundleError(
      "BUNDLE_INPUT_INVALID",
      `bundle job path is duplicated: '${job.path}'`,
    );
  }
  seenPaths.add(job.path);
  if (job.inspectedNode.inspection.jobId !== job.inspectedNode.jobId) {
    throw new BundleError(
      "BUNDLE_INPUT_INVALID",
      `inspected job ID does not match preflight result for '${job.inspectedNode.nodeId}'`,
    );
  }
  for (const exception of job.inspectedNode.approvedExceptions) {
    if (
      exception.node_id !== job.inspectedNode.nodeId ||
      !job.inspectedNode.nondeterministicCodes.includes(exception.code)
    ) {
      throw new BundleError(
        "BUNDLE_INPUT_INVALID",
        `approved exception does not match inspected job '${job.inspectedNode.nodeId}'`,
      );
    }
  }
}

function exceptionSortKey(exception: ApprovedInspectionException): string {
  return [
    exception.node_id,
    exception.code,
    exception.approved_by,
    exception.approved_at,
    exception.reason,
  ].join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBundleManifest(value: unknown): value is BundleManifest {
  return (
    isRecord(value) &&
    value.formatVersion === 1 &&
    value.kind === "EXECUTION_BUNDLE_MANIFEST" &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every(isBundleFileManifest)
  );
}

function isBundleFileManifest(value: unknown): value is BundleFileManifest {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    return false;
  }
  if (value.path === "network.yaml") {
    return (
      value.nodeId === undefined &&
      value.jobId === undefined &&
      value.nondeterministicCodes === undefined &&
      value.approvedExceptions === undefined
    );
  }
  if (
    !/^jobs\/[A-Za-z0-9._-]+\.sql$/u.test(value.path) ||
    typeof value.nodeId !== "string" ||
    typeof value.jobId !== "string" ||
    !Array.isArray(value.nondeterministicCodes) ||
    !value.nondeterministicCodes.every((code) => typeof code === "string") ||
    !Array.isArray(value.approvedExceptions) ||
    !value.approvedExceptions.every(isApprovedException)
  ) {
    return false;
  }
  const codes: readonly string[] = value.nondeterministicCodes;
  const exceptions: readonly ApprovedInspectionException[] =
    value.approvedExceptions;
  return exceptions.every(
    (exception) =>
      exception.node_id === value.nodeId && codes.includes(exception.code),
  );
}

function isApprovedException(
  value: unknown,
): value is ApprovedInspectionException {
  return (
    isRecord(value) &&
    typeof value.node_id === "string" &&
    value.code === "KSQL1306" &&
    typeof value.approved_by === "string" &&
    typeof value.reason === "string" &&
    typeof value.approved_at === "string"
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
