import { networkLockKey } from "../domain/canonical-lock-key.js";
import { KintoneClient, type KintoneRecord } from "./kintone/client.js";
import { RepositoryError } from "./repository.js";

export interface NetworkLockStatus {
  readonly record_id: string;
  readonly owner_invocation_id: string;
  readonly owner_instance_id: string;
  readonly heartbeat_at: string;
  readonly lease_expires_at: string;
  readonly revision: number;
}

export interface NetworkLockStatusReader {
  getNetworkLock(
    profile: string,
    networkId: string,
  ): Promise<NetworkLockStatus | null>;
}

export interface KintoneNetworkLockStatusReaderConfig {
  readonly baseUrl: string;
  readonly stateAppId: number;
  readonly stateApiToken: string;
  readonly fetch?: typeof fetch;
}

const text = (record: KintoneRecord, code: string): string =>
  String(record[code]?.value ?? "");

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export class KintoneNetworkLockStatusReader implements NetworkLockStatusReader {
  private readonly client: KintoneClient;

  constructor(config: KintoneNetworkLockStatusReaderConfig) {
    this.client = new KintoneClient({
      baseUrl: config.baseUrl,
      appId: config.stateAppId,
      apiToken: config.stateApiToken,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
  }

  async getNetworkLock(
    profile: string,
    networkId: string,
  ): Promise<NetworkLockStatus | null> {
    const lockKey = networkLockKey(profile, networkId);
    const records = await this.client.getRecords(
      `record_type in ("NETWORK_LOCK") and lock_key in (${quote(lockKey)}) and status in ("RUNNING")`,
    );
    if (records.length === 0) return null;
    if (records.length !== 1) {
      throw new RepositoryError(
        "MULTIPLE_RECORDS",
        "multiple active Network locks matched",
      );
    }
    const record = records[0]!;
    const statusReason = text(record, "status_reason");
    const ownerInstanceId = statusReason.startsWith("owner_instance_id=")
      ? statusReason.slice("owner_instance_id=".length)
      : "";
    return {
      record_id: text(record, "$id"),
      owner_invocation_id: text(record, "owner_invocation_id"),
      owner_instance_id: ownerInstanceId,
      heartbeat_at: text(record, "heartbeat_at"),
      lease_expires_at: text(record, "lease_expires_at"),
      revision: Number(record.revision?.value),
    };
  }
}
