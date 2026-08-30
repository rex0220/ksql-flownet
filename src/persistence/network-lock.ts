import { createHash, randomUUID } from "node:crypto";

import {
  MAX_KINTONE_UNIQUE_KEY_LENGTH,
  networkLockKey,
  type CanonicalLockKey,
} from "../domain/canonical-lock-key.js";
import {
  KintoneApiError,
  KintoneClient,
  KintoneTransportError,
  type KintoneFieldValue,
  type KintoneRecord,
} from "./kintone/client.js";

export type NetworkLockErrorCode =
  | "LOCK_CONFLICT"
  | "LOCK_UNAVAILABLE"
  | "LEASE_TOKEN_MISMATCH"
  | "LEASE_REVISION_MISMATCH"
  | "LEASE_REVISION_CONFLICT";

export class NetworkLockError extends Error {
  readonly code: NetworkLockErrorCode;
  readonly causeDetail: unknown;

  constructor(
    code: NetworkLockErrorCode,
    message: string,
    causeDetail?: unknown,
  ) {
    super(message);
    this.name = "NetworkLockError";
    this.code = code;
    this.causeDetail = causeDetail;
  }
}

export interface NetworkLockReference {
  readonly lockKey: CanonicalLockKey<"N1">;
  readonly recordId: string;
  readonly originalRecordKey: string;
  readonly leaseToken: string;
  readonly ownerInvocationId: string;
  readonly leaseDurationSec: number;
  revision: number;
  businessRevision: number;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface NetworkLockManagerConfig {
  baseUrl: string;
  appId: number;
  apiToken: string;
  profile: string;
  networkId: string;
  ownerInvocationId: string;
  ownerInstanceId: string;
  leaseDurationSec: number;
  fetch?: typeof fetch;
  now?: () => Date;
  uuid?: () => string;
}

const field = (value: unknown): KintoneFieldValue => ({ value });
const text = (record: KintoneRecord, code: string): string =>
  String(record[code]?.value ?? "");
const revisionOf = (record: KintoneRecord): number =>
  Number(record.$revision?.value);
const idOf = (record: KintoneRecord): string => text(record, "$id");

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function recordKeyFor(lockKey: CanonicalLockKey<"N1">): string {
  const value = `LOCK:${lockKey}`;
  if (value.length > MAX_KINTONE_UNIQUE_KEY_LENGTH) {
    throw new NetworkLockError(
      "LOCK_UNAVAILABLE",
      `network lock record key exceeds ${MAX_KINTONE_UNIQUE_KEY_LENGTH} characters`,
    );
  }
  return value;
}

export function releaseTombstoneRecordKey(uniqueValue: string): string {
  const direct = `LOCKDONE:${uniqueValue}`;
  if (direct.length <= MAX_KINTONE_UNIQUE_KEY_LENGTH) return direct;
  const digest = createHash("sha256")
    .update(uniqueValue, "utf8")
    .digest("base64url");
  return `LOCKDONE:${digest}`;
}

function decodeReference(
  record: KintoneRecord,
  lockKey: CanonicalLockKey<"N1">,
  recordKey: string,
  leaseDurationSec: number,
): NetworkLockReference {
  return {
    lockKey,
    recordId: idOf(record),
    originalRecordKey: recordKey,
    leaseToken: text(record, "lease_token"),
    ownerInvocationId: text(record, "owner_invocation_id"),
    leaseDurationSec,
    revision: revisionOf(record),
    businessRevision: Number(record.revision?.value),
    heartbeatAt: text(record, "heartbeat_at"),
    leaseExpiresAt: text(record, "lease_expires_at"),
  };
}

export class NetworkLockManager {
  private readonly client: KintoneClient;
  private readonly config: NetworkLockManagerConfig;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  readonly lockKey: CanonicalLockKey<"N1">;
  readonly recordKey: string;

  constructor(config: NetworkLockManagerConfig) {
    if (
      !Number.isSafeInteger(config.leaseDurationSec) ||
      config.leaseDurationSec <= 0
    ) {
      throw new TypeError("leaseDurationSec must be a positive integer");
    }
    this.config = config;
    this.now = config.now ?? (() => new Date());
    this.uuid = config.uuid ?? randomUUID;
    this.lockKey = networkLockKey(config.profile, config.networkId);
    this.recordKey = recordKeyFor(this.lockKey);
    this.client = new KintoneClient({
      baseUrl: config.baseUrl,
      appId: config.appId,
      apiToken: config.apiToken,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  async acquire(): Promise<NetworkLockReference> {
    const acquiredAt = this.now();
    const leaseToken = this.uuid();
    const leaseExpiresAt = new Date(
      acquiredAt.getTime() + this.config.leaseDurationSec * 1000,
    ).toISOString();
    const record: KintoneRecord = {
      record_key: field(this.recordKey),
      record_type: field("NETWORK_LOCK"),
      lock_key: field(this.lockKey),
      profile: field(this.config.profile),
      owner_invocation_id: field(this.config.ownerInvocationId),
      lease_token: field(leaseToken),
      started_at: field(acquiredAt.toISOString()),
      heartbeat_at: field(acquiredAt.toISOString()),
      lease_expires_at: field(leaseExpiresAt),
      status: field("RUNNING"),
      revision: field(1),
      status_reason: field(`owner_instance_id=${this.config.ownerInstanceId}`),
    };
    try {
      const created = await this.client.postRecord(record);
      return decodeReference(
        {
          ...record,
          $id: field(created.id),
          $revision: field(created.revision),
        },
        this.lockKey,
        this.recordKey,
        this.config.leaseDurationSec,
      );
    } catch (error) {
      if (!(
        error instanceof KintoneTransportError ||
        (error instanceof KintoneApiError &&
          error.status === 400 &&
          error.apiCode === "CB_VA01")
      )) {
        throw new NetworkLockError(
          "LOCK_UNAVAILABLE",
          "network lock insert failed",
          error,
        );
      }
      const current = await this.getUniqueAfterAcquireFailure(error);
      if (
        text(current, "status") === "RUNNING" &&
        text(current, "lease_token") === leaseToken &&
        text(current, "owner_invocation_id") === this.config.ownerInvocationId
      ) {
        return decodeReference(
          current,
          this.lockKey,
          this.recordKey,
          this.config.leaseDurationSec,
        );
      }
      if (text(current, "status") === "RUNNING") {
        throw new NetworkLockError(
          "LOCK_CONFLICT",
          "network lock is held",
          error,
        );
      }
      throw new NetworkLockError(
        "LOCK_UNAVAILABLE",
        "network lock insert outcome could not be confirmed",
        error,
      );
    }
  }

  async heartbeat(
    reference: NetworkLockReference,
  ): Promise<NetworkLockReference> {
    const current = await this.getUnique(reference.originalRecordKey);
    this.assertFence(current, reference);
    const at = this.now();
    const leaseExpiresAt = new Date(
      at.getTime() + reference.leaseDurationSec * 1000,
    ).toISOString();
    let revision: number;
    try {
      revision = await this.client.putRecord(
        reference.originalRecordKey,
        reference.revision,
        {
          heartbeat_at: field(at.toISOString()),
          lease_expires_at: field(leaseExpiresAt),
          revision: field(reference.businessRevision + 1),
        },
      );
    } catch (error) {
      if (error instanceof KintoneApiError && error.status === 409) {
        throw new NetworkLockError(
          "LEASE_REVISION_CONFLICT",
          "network lease revision conflicted",
          error,
        );
      }
      if (error instanceof KintoneTransportError) {
        const adjudicated = await this.getUnique(reference.originalRecordKey);
        if (
          text(adjudicated, "lease_token") === reference.leaseToken &&
          revisionOf(adjudicated) === reference.revision + 1 &&
          text(adjudicated, "heartbeat_at") === at.toISOString() &&
          text(adjudicated, "lease_expires_at") === leaseExpiresAt
        ) {
          revision = revisionOf(adjudicated);
        } else {
          throw new NetworkLockError(
            "LOCK_UNAVAILABLE",
            "network heartbeat outcome could not be confirmed",
            error,
          );
        }
      } else {
        throw new NetworkLockError(
          "LOCK_UNAVAILABLE",
          "network heartbeat failed",
          error,
        );
      }
    }
    reference.revision = revision;
    reference.businessRevision += 1;
    reference.heartbeatAt = at.toISOString();
    reference.leaseExpiresAt = leaseExpiresAt;
    return reference;
  }

  async release(
    reference: NetworkLockReference,
    status = "SUCCESS",
    resultCode = "NORMAL",
  ): Promise<{ released: true; recordKey: string }> {
    const current = await this.getUnique(reference.originalRecordKey);
    this.assertFence(current, reference);
    const tombstone = releaseTombstoneRecordKey(
      `${reference.lockKey}:${reference.leaseToken}`,
    );
    const releaseRecord = () =>
      this.client.putRecordById(reference.recordId, reference.revision, {
        record_key: field(tombstone),
        lock_key: field(""),
        owner_invocation_id: field(""),
        lease_token: field(""),
        status: field(status),
        status_reason: field(resultCode),
        finished_at: field(this.now().toISOString()),
        revision: field(reference.businessRevision + 1),
      });
    const adjudicateLostResponse = async (
      cause: KintoneTransportError,
    ): Promise<{ released: true; recordKey: string }> => {
      try {
        const adjudicated = await this.getUnique(tombstone);
        if (
          text(adjudicated, "lock_key") === "" &&
          text(adjudicated, "lease_token") === "" &&
          text(adjudicated, "status") === status
        ) {
          reference.revision = revisionOf(adjudicated);
          reference.businessRevision = Number(adjudicated.revision?.value);
          return { released: true, recordKey: tombstone };
        }
      } catch {
        // The stable error below intentionally hides ambiguous remote details.
      }
      throw new NetworkLockError(
        "LOCK_UNAVAILABLE",
        "network lock release outcome could not be confirmed",
        cause,
      );
    };
    try {
      const revision = await releaseRecord();
      reference.revision = revision;
      reference.businessRevision += 1;
      return { released: true, recordKey: tombstone };
    } catch (error) {
      if (error instanceof KintoneApiError && error.status === 409) {
        let latest: KintoneRecord;
        try {
          latest = await this.getUnique(reference.originalRecordKey);
        } catch (retryError) {
          throw new NetworkLockError(
            "LEASE_REVISION_CONFLICT",
            "network lock release revision conflicted",
            retryError,
          );
        }
        if (
          text(latest, "record_key") !== reference.originalRecordKey ||
          text(latest, "lease_token") !== reference.leaseToken
        ) {
          throw new NetworkLockError(
            "LEASE_REVISION_CONFLICT",
            "network lock release revision conflicted",
            error,
          );
        }
        // A revision advanced by our own heartbeat is safe to release once.
        reference.revision = revisionOf(latest);
        reference.businessRevision = Number(latest.revision?.value);
        try {
          const revision = await releaseRecord();
          reference.revision = revision;
          reference.businessRevision += 1;
          return { released: true, recordKey: tombstone };
        } catch (retryError) {
          if (
            retryError instanceof KintoneApiError &&
            retryError.status === 409
          )
            throw new NetworkLockError(
              "LEASE_REVISION_CONFLICT",
              "network lock release revision conflicted",
              retryError,
            );
          if (retryError instanceof KintoneTransportError)
            return adjudicateLostResponse(retryError);
          throw new NetworkLockError(
            "LOCK_UNAVAILABLE",
            "network lock release failed",
            retryError,
          );
        }
      }
      if (error instanceof KintoneTransportError) {
        return adjudicateLostResponse(error);
      }
      throw new NetworkLockError(
        "LOCK_UNAVAILABLE",
        "network lock release failed",
        error,
      );
    }
  }

  private async getUniqueAfterAcquireFailure(
    cause: unknown,
  ): Promise<KintoneRecord> {
    try {
      return await this.getUnique(this.recordKey);
    } catch (error) {
      throw new NetworkLockError(
        "LOCK_UNAVAILABLE",
        "network lock holder could not be confirmed",
        { cause, adjudication: error },
      );
    }
  }

  private async getUnique(recordKey: string): Promise<KintoneRecord> {
    let records: KintoneRecord[];
    try {
      records = await this.client.getRecords(
        `record_key in (${quote(recordKey)})`,
      );
    } catch (error) {
      throw new NetworkLockError(
        "LOCK_UNAVAILABLE",
        "network lock read failed",
        error,
      );
    }
    if (records.length !== 1) {
      throw new NetworkLockError(
        "LOCK_UNAVAILABLE",
        `network lock read returned ${records.length} records`,
      );
    }
    return records[0]!;
  }

  private assertFence(
    current: KintoneRecord,
    reference: NetworkLockReference,
  ): void {
    if (text(current, "lease_token") !== reference.leaseToken) {
      throw new NetworkLockError(
        "LEASE_TOKEN_MISMATCH",
        "network lease token no longer matches",
      );
    }
    if (revisionOf(current) !== reference.revision) {
      throw new NetworkLockError(
        "LEASE_REVISION_MISMATCH",
        "network lease revision no longer matches",
      );
    }
  }
}

export type LeaseMonitorState =
  "HELD" | "LEASE_UNCERTAIN" | "FINAL_WRITE_CONFIRMED";

export interface LeaseMonitorEvent {
  previous: LeaseMonitorState;
  current: LeaseMonitorState;
  reason:
    | "FAILURE_THRESHOLD"
    | "LEASE_SAFETY_THRESHOLD"
    | "FENCE_LOST"
    | "FINAL_WRITE_CONFIRMED";
  at: string;
}

export interface LeaseMonitorConfig {
  leaseDurationSec: number;
  heartbeatIntervalSec: number;
  consecutiveFailureThreshold?: number;
  remainingLeaseSafetySec?: number;
  now?: () => Date;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

export class LeaseMonitor {
  private state: LeaseMonitorState = "HELD";
  private failures = 0;
  private timer: unknown = null;
  private tickInFlight: Promise<boolean> | null = null;
  private readonly listeners = new Set<(event: LeaseMonitorEvent) => void>();
  private readonly now: () => Date;
  private readonly failureThreshold: number;
  private readonly safetyMs: number;
  private readonly schedule: (
    callback: () => void,
    intervalMs: number,
  ) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;

  constructor(
    private readonly manager: NetworkLockManager,
    private readonly reference: NetworkLockReference,
    private readonly config: LeaseMonitorConfig,
  ) {
    validateMonitorConfig(config);
    this.now = config.now ?? (() => new Date());
    this.failureThreshold = config.consecutiveFailureThreshold ?? 3;
    this.safetyMs =
      (config.remainingLeaseSafetySec ?? config.heartbeatIntervalSec) * 1000;
    this.schedule =
      config.schedule ??
      ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelSchedule =
      config.cancelSchedule ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get currentState(): LeaseMonitorState {
    return this.state;
  }

  canStartNewNode(): boolean {
    return this.state === "HELD";
  }

  canPersistResults(): boolean {
    return this.state === "HELD" || this.state === "FINAL_WRITE_CONFIRMED";
  }

  requiresNetworkLeaseInterruptedFinalization(): boolean {
    return this.state === "FINAL_WRITE_CONFIRMED";
  }

  subscribe(listener: (event: LeaseMonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async tick(): Promise<boolean> {
    if (this.tickInFlight !== null) return this.tickInFlight;
    const operation = this.performTick();
    this.tickInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.tickInFlight === operation) this.tickInFlight = null;
    }
  }

  private async performTick(): Promise<boolean> {
    if (this.state !== "HELD") return false;
    try {
      await this.manager.heartbeat(this.reference);
      this.failures = 0;
      return true;
    } catch (error) {
      this.failures += 1;
      const fenceLost =
        error instanceof NetworkLockError &&
        (error.code === "LEASE_TOKEN_MISMATCH" ||
          error.code === "LEASE_REVISION_MISMATCH" ||
          error.code === "LEASE_REVISION_CONFLICT");
      if (fenceLost) this.transition("LEASE_UNCERTAIN", "FENCE_LOST");
      else if (this.failures >= this.failureThreshold)
        this.transition("LEASE_UNCERTAIN", "FAILURE_THRESHOLD");
      else if (this.remainingLeaseMs() <= this.safetyMs)
        this.transition("LEASE_UNCERTAIN", "LEASE_SAFETY_THRESHOLD");
      return false;
    }
  }

  async confirmLeaseForFinalWrite(): Promise<boolean> {
    if (this.tickInFlight !== null) await this.tickInFlight;
    if (this.state !== "LEASE_UNCERTAIN") return false;
    try {
      await this.manager.heartbeat(this.reference);
      this.transition("FINAL_WRITE_CONFIRMED", "FINAL_WRITE_CONFIRMED");
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.schedule(
      () => void this.tick().catch(() => undefined),
      this.config.heartbeatIntervalSec * 1000,
    );
  }

  stop(): void {
    if (this.timer === null) return;
    this.cancelSchedule(this.timer);
    this.timer = null;
  }

  private remainingLeaseMs(): number {
    return Date.parse(this.reference.leaseExpiresAt) - this.now().getTime();
  }

  private transition(
    current: LeaseMonitorState,
    reason: LeaseMonitorEvent["reason"],
  ): void {
    if (this.state === current) return;
    const previous = this.state;
    this.state = current;
    const event = { previous, current, reason, at: this.now().toISOString() };
    for (const listener of this.listeners) listener(event);
  }
}

function validateMonitorConfig(config: LeaseMonitorConfig): void {
  if (
    (config.schedule === undefined) !==
    (config.cancelSchedule === undefined)
  ) {
    throw new TypeError(
      "schedule and cancelSchedule must be provided together",
    );
  }
  for (const [name, value] of [
    ["leaseDurationSec", config.leaseDurationSec],
    ["heartbeatIntervalSec", config.heartbeatIntervalSec],
    ["consecutiveFailureThreshold", config.consecutiveFailureThreshold ?? 3],
    [
      "remainingLeaseSafetySec",
      config.remainingLeaseSafetySec ?? config.heartbeatIntervalSec,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  if (config.heartbeatIntervalSec >= config.leaseDurationSec) {
    throw new TypeError(
      "heartbeatIntervalSec must be shorter than leaseDurationSec",
    );
  }
}
