import type { InputBaseline } from "./io-path.js";
import type { ExecutionOutputFile } from "../executor/result-classifier.js";

export const INPUT_AUDIT_SUMMARY_MAX_LENGTH = 10_000;

export interface StoredInputBaseline {
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface InputFileReceipt extends StoredInputBaseline {
  readonly rows: number;
  readonly encoding: string;
}

interface BaselineEnvelope {
  readonly version: 1;
  readonly kind: "KSQL_FLOWNET_INPUT_BASELINE";
  readonly inputs: readonly StoredInputBaseline[];
}

export function serializeInputBaseline(
  inputs: readonly Pick<InputBaseline, "name" | "sha256" | "bytes">[],
): string {
  const normalized = normalizeBaseline(inputs);
  const summary = checkedJson({
    version: 1,
    kind: "KSQL_FLOWNET_INPUT_BASELINE",
    inputs: normalized,
  } satisfies BaselineEnvelope);
  // Reserve enough room for the terminal receipt form before accepting the
  // pre-execution baseline into the fixed-size safe summary field.
  checkedJson({
    version: 1,
    kind: "KSQL_FLOWNET_INPUT_AUDIT",
    baseline: normalized,
    input_files: normalized.map((input) => ({
      source: input.source,
      type: "IMPORT",
      sha256: input.sha256.slice(0, 12),
      bytes: input.bytes,
      rows: Number.MAX_SAFE_INTEGER,
      encoding: "x".repeat(32),
    })),
  });
  return summary;
}

export function parseInputBaseline(
  summary: string | null,
): StoredInputBaseline[] | null {
  if (summary === null || summary.length > INPUT_AUDIT_SUMMARY_MAX_LENGTH)
    return null;
  let value: unknown;
  try {
    value = JSON.parse(summary);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.kind === "KSQL_FLOWNET_IO_AUDIT") {
    if (
      !hasOnlyKeys(value, [
        "version",
        "kind",
        "baseline",
        "input_files",
        "output_files",
      ])
    )
      throw new Error("IO audit summary has unknown fields");
    if (value.version !== 1 || !Array.isArray(value.baseline))
      throw new Error("IO audit summary has an invalid version or baseline");
    return strictBaseline(value.baseline);
  }
  if (value.kind === "KSQL_FLOWNET_INPUT_AUDIT") {
    if (!hasOnlyKeys(value, ["version", "kind", "baseline", "input_files"]))
      throw new Error("input audit summary has unknown fields");
    if (value.version !== 1 || !Array.isArray(value.baseline))
      throw new Error("input audit summary has an invalid version or baseline");
    return strictBaseline(value.baseline);
  }
  if (value.kind !== "KSQL_FLOWNET_INPUT_BASELINE") return null;
  if (!hasOnlyKeys(value, ["version", "kind", "inputs"]))
    throw new Error("input baseline summary has unknown fields");
  if (value.version !== 1 || !Array.isArray(value.inputs))
    throw new Error("input baseline summary has an invalid version or inputs");
  return strictBaseline(value.inputs);
}

export function serializeInputAuditSummary(
  baseline: readonly Pick<InputBaseline, "name" | "sha256" | "bytes">[],
  receipts: readonly InputFileReceipt[],
): string {
  const normalizedBaseline = normalizeBaseline(baseline);
  const normalizedReceipts = [...receipts]
    .sort((left, right) => compareText(left.source, right.source))
    .map((receipt) => {
      assertStoredBaseline(receipt);
      if (!Number.isSafeInteger(receipt.rows) || receipt.rows < 0)
        throw new Error("input receipt rows must be a non-negative integer");
      if (!/^[A-Za-z0-9._-]{1,32}$/u.test(receipt.encoding))
        throw new Error("input receipt encoding is invalid");
      return {
        source: receipt.source,
        type: "IMPORT" as const,
        sha256: receipt.sha256.slice(0, 12),
        bytes: receipt.bytes,
        rows: receipt.rows,
        encoding: receipt.encoding,
      };
    });
  return checkedJson({
    version: 1,
    kind: "KSQL_FLOWNET_INPUT_AUDIT",
    baseline: normalizedBaseline,
    input_files: normalizedReceipts,
  });
}

export function serializeOutputAuditSummary(
  outputs: readonly ExecutionOutputFile[],
): string {
  return checkedJson({
    version: 1,
    kind: "KSQL_FLOWNET_OUTPUT_AUDIT",
    output_files: normalizeOutputReceipts(outputs),
  });
}

export function serializeIoAuditSummary(
  baseline: readonly Pick<InputBaseline, "name" | "sha256" | "bytes">[],
  inputReceipts: readonly InputFileReceipt[],
  outputReceipts: readonly ExecutionOutputFile[],
): string {
  const inputAudit = JSON.parse(
    serializeInputAuditSummary(baseline, inputReceipts),
  ) as Record<string, unknown>;
  return checkedJson({
    version: 1,
    kind: "KSQL_FLOWNET_IO_AUDIT",
    baseline: inputAudit.baseline,
    input_files: inputAudit.input_files,
    output_files: normalizeOutputReceipts(outputReceipts),
  });
}

function normalizeOutputReceipts(
  outputs: readonly ExecutionOutputFile[],
): readonly unknown[] {
  const normalized = outputs.map((output) => {
    if (
      !isSafeSourceName(output.name) ||
      !/^[a-f0-9]{64}$/u.test(output.sha256) ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 0 ||
      !Number.isSafeInteger(output.rows) ||
      output.rows < 0 ||
      !["utf8", "sjis"].includes(output.encoding)
    )
      throw new Error("output receipt contains invalid audit metadata");
    return {
      sink: output.name,
      type: "EXPORT" as const,
      sha256: output.sha256,
      bytes: output.bytes,
      rows: output.rows,
      encoding: output.encoding,
    };
  });
  if (
    new Set(normalized.map((output) => output.sink)).size !== normalized.length
  )
    throw new Error("output receipt sink names must be unique");
  return normalized;
}

export function inputBaselinesEqual(
  expected: readonly StoredInputBaseline[],
  actual: readonly Pick<InputBaseline, "name" | "sha256" | "bytes">[],
): boolean {
  return serializeStoredBaseline(expected) === serializeInputBaseline(actual);
}

function serializeStoredBaseline(
  inputs: readonly StoredInputBaseline[],
): string {
  for (const input of inputs) assertStoredBaseline(input);
  return checkedJson({
    version: 1,
    kind: "KSQL_FLOWNET_INPUT_BASELINE",
    inputs: [...inputs].sort((left, right) =>
      compareText(left.source, right.source),
    ),
  } satisfies BaselineEnvelope);
}

function normalizeBaseline(
  inputs: readonly Pick<InputBaseline, "name" | "sha256" | "bytes">[],
): StoredInputBaseline[] {
  const normalized = inputs
    .map((input) => ({
      source: input.name,
      sha256: input.sha256,
      bytes: input.bytes,
    }))
    .sort((left, right) => compareText(left.source, right.source));
  for (const input of normalized) assertStoredBaseline(input);
  if (
    new Set(normalized.map((input) => input.source)).size !== normalized.length
  )
    throw new Error("input baseline source names must be unique");
  return normalized;
}

function strictBaseline(value: readonly unknown[]): StoredInputBaseline[] {
  const inputs = value.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["source", "sha256", "bytes"]))
      throw new Error("input baseline entry has an invalid shape");
    const baseline = {
      source: item.source,
      sha256: item.sha256,
      bytes: item.bytes,
    };
    assertStoredBaseline(baseline);
    return baseline;
  });
  const canonical = [...inputs].sort((left, right) =>
    compareText(left.source, right.source),
  );
  if (JSON.stringify(inputs) !== JSON.stringify(canonical))
    throw new Error("input baseline entries are not in canonical source order");
  if (new Set(inputs.map((input) => input.source)).size !== inputs.length)
    throw new Error("input baseline source names must be unique");
  return inputs;
}

function assertStoredBaseline(value: {
  readonly source: unknown;
  readonly sha256: unknown;
  readonly bytes: unknown;
}): asserts value is StoredInputBaseline {
  if (
    typeof value.source !== "string" ||
    !isSafeSourceName(value.source) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0
  )
    throw new Error(
      "input baseline accepts only source, SHA-256, and byte count",
    );
}

function isSafeSourceName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    value !== "__net__" &&
    !value.includes(":") &&
    !value.includes("=") &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function checkedJson(value: unknown): string {
  const summary = JSON.stringify(value);
  if (summary.length > INPUT_AUDIT_SUMMARY_MAX_LENGTH)
    throw new Error(
      `input audit summary exceeds ${INPUT_AUDIT_SUMMARY_MAX_LENGTH} characters`,
    );
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
