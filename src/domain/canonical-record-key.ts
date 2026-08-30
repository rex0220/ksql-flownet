import { createHash } from "node:crypto";

import {
  MAX_CANONICAL_LOCK_IDENTIFIER_LENGTH,
  MAX_KINTONE_UNIQUE_KEY_LENGTH,
} from "./canonical-lock-key.js";

export const CANONICAL_RECORD_KEY_LENGTH = 46;

declare const canonicalRecordKeyBrand: unique symbol;
export type CanonicalRecordKey<Prefix extends "S1" | "A1"> =
  `${Prefix}:${string}` & {
    readonly [canonicalRecordKeyBrand]: Prefix;
  };

export type CanonicalRecordKeyErrorCode =
  | "RECORD_KEY_IDENTIFIER_NOT_STRING"
  | "RECORD_KEY_IDENTIFIER_EMPTY"
  | "RECORD_KEY_IDENTIFIER_NUL"
  | "RECORD_KEY_IDENTIFIER_SEPARATOR"
  | "RECORD_KEY_IDENTIFIER_RESERVED"
  | "RECORD_KEY_IDENTIFIER_TOO_LONG"
  | "RECORD_KEY_ATTEMPT_NO_INVALID"
  | "RECORD_KEY_LENGTH_INVARIANT";

type RecordKeyComponent = "runId" | "nodeId" | "attemptNo" | "generatedKey";

export class CanonicalRecordKeyError extends Error {
  readonly code: CanonicalRecordKeyErrorCode;
  readonly component: RecordKeyComponent;

  constructor(
    code: CanonicalRecordKeyErrorCode,
    component: RecordKeyComponent,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalRecordKeyError";
    this.code = code;
    this.component = component;
  }
}

function canonicalIdentifier(
  value: string,
  component: "runId" | "nodeId",
): string {
  if (typeof value !== "string") {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_IDENTIFIER_NOT_STRING",
      component,
      `${component} must be a string`,
    );
  }
  if (value.length === 0) {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_IDENTIFIER_EMPTY",
      component,
      `${component} must not be empty`,
    );
  }
  if (value.includes("\0")) {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_IDENTIFIER_NUL",
      component,
      `${component} must not contain NUL`,
    );
  }
  if (value.includes(":")) {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_IDENTIFIER_SEPARATOR",
      component,
      `${component} must not contain ':'`,
    );
  }
  if (value === "__net__") {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_IDENTIFIER_RESERVED",
      component,
      `${component} must not use reserved identifier '__net__'`,
    );
  }
  const normalized = value.normalize("NFC");
  if (Array.from(normalized).length > MAX_CANONICAL_LOCK_IDENTIFIER_LENGTH) {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_IDENTIFIER_TOO_LONG",
      component,
      `${component} must be at most ${MAX_CANONICAL_LOCK_IDENTIFIER_LENGTH} Unicode characters after NFC normalization`,
    );
  }
  return normalized;
}

function canonicalKey<Prefix extends "S1" | "A1">(
  prefix: Prefix,
  components: readonly string[],
): CanonicalRecordKey<Prefix> {
  const digest = createHash("sha256")
    .update([prefix, ...components].join("\0"), "utf8")
    .digest("base64url");
  const key = `${prefix}:${digest}`;
  if (
    key.length !== CANONICAL_RECORD_KEY_LENGTH ||
    key.length > MAX_KINTONE_UNIQUE_KEY_LENGTH
  ) {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_LENGTH_INVARIANT",
      "generatedKey",
      "generated canonical record key violates its length contract",
    );
  }
  return key as CanonicalRecordKey<Prefix>;
}

export function nodeStateKey(
  runId: string,
  nodeId: string,
): CanonicalRecordKey<"S1"> {
  return canonicalKey("S1", [
    canonicalIdentifier(runId, "runId"),
    canonicalIdentifier(nodeId, "nodeId"),
  ]);
}

export function attemptKey(
  runId: string,
  nodeId: string,
  attemptNo: number,
): CanonicalRecordKey<"A1"> {
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    throw new CanonicalRecordKeyError(
      "RECORD_KEY_ATTEMPT_NO_INVALID",
      "attemptNo",
      "attemptNo must be a positive safe integer",
    );
  }
  return canonicalKey("A1", [
    canonicalIdentifier(runId, "runId"),
    canonicalIdentifier(nodeId, "nodeId"),
    String(attemptNo),
  ]);
}
