import { createHash } from "node:crypto";

// Keep these rules aligned with the identifier constraints enforced by
// schemas/network-definition.schema.json and validate-network.ts.
export const MAX_CANONICAL_LOCK_IDENTIFIER_LENGTH = 128;
export const CANONICAL_LOCK_KEY_LENGTH = 46;
export const MAX_KINTONE_UNIQUE_KEY_LENGTH = 64;

declare const canonicalLockKeyBrand: unique symbol;
export type CanonicalLockKey<Prefix extends "N1" | "J1"> =
  `${Prefix}:${string}` & {
    readonly [canonicalLockKeyBrand]: Prefix;
  };

export type CanonicalLockKeyErrorCode =
  | "LOCK_KEY_IDENTIFIER_NOT_STRING"
  | "LOCK_KEY_IDENTIFIER_EMPTY"
  | "LOCK_KEY_IDENTIFIER_NUL"
  | "LOCK_KEY_IDENTIFIER_SEPARATOR"
  | "LOCK_KEY_IDENTIFIER_RESERVED"
  | "LOCK_KEY_IDENTIFIER_TOO_LONG"
  | "LOCK_KEY_LENGTH_INVARIANT";

export class CanonicalLockKeyError extends Error {
  readonly code: CanonicalLockKeyErrorCode;
  readonly component: "profile" | "networkId" | "jobId" | "generatedKey";

  constructor(
    code: CanonicalLockKeyErrorCode,
    component: "profile" | "networkId" | "jobId" | "generatedKey",
    message: string,
  ) {
    super(message);
    this.name = "CanonicalLockKeyError";
    this.code = code;
    this.component = component;
  }
}

function canonicalIdentifier(
  value: string,
  component: "profile" | "networkId" | "jobId",
): string {
  if (typeof value !== "string") {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_IDENTIFIER_NOT_STRING",
      component,
      `${component} must be a string`,
    );
  }
  if (value.length === 0) {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_IDENTIFIER_EMPTY",
      component,
      `${component} must not be empty`,
    );
  }
  if (value.includes("\0")) {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_IDENTIFIER_NUL",
      component,
      `${component} must not contain NUL`,
    );
  }
  if (value.includes(":")) {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_IDENTIFIER_SEPARATOR",
      component,
      `${component} must not contain ':'`,
    );
  }
  if (value === "__net__") {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_IDENTIFIER_RESERVED",
      component,
      `${component} must not use reserved identifier '__net__'`,
    );
  }

  const normalized = value.normalize("NFC");
  const length = Array.from(normalized).length;
  if (length > MAX_CANONICAL_LOCK_IDENTIFIER_LENGTH) {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_IDENTIFIER_TOO_LONG",
      component,
      `${component} must be at most ${MAX_CANONICAL_LOCK_IDENTIFIER_LENGTH} Unicode characters after NFC normalization`,
    );
  }
  return normalized;
}

function lockKey<Prefix extends "N1" | "J1">(
  prefix: Prefix,
  profile: string,
  identifier: string,
  component: "networkId" | "jobId",
): CanonicalLockKey<Prefix> {
  const canonicalProfile = canonicalIdentifier(profile, "profile");
  const canonicalTarget = canonicalIdentifier(identifier, component);
  const canonicalInput = `${prefix}\0${canonicalProfile}\0${canonicalTarget}`;
  const digest = createHash("sha256")
    .update(canonicalInput, "utf8")
    .digest("base64url");
  const key = `${prefix}:${digest}`;

  if (
    key.length !== CANONICAL_LOCK_KEY_LENGTH ||
    key.length > MAX_KINTONE_UNIQUE_KEY_LENGTH
  ) {
    throw new CanonicalLockKeyError(
      "LOCK_KEY_LENGTH_INVARIANT",
      "generatedKey",
      "generated canonical lock key violates its length contract",
    );
  }
  return key as CanonicalLockKey<Prefix>;
}

export function networkLockKey(
  profile: string,
  networkId: string,
): CanonicalLockKey<"N1"> {
  return lockKey("N1", profile, networkId, "networkId");
}

export function jobLockKey(
  profile: string,
  jobId: string,
): CanonicalLockKey<"J1"> {
  return lockKey("J1", profile, jobId, "jobId");
}
