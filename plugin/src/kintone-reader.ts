import {
  KintoneRecordError,
  requiredText,
  type KintoneRecord,
} from "./kintone-record.js";

export interface RecordsRequest {
  readonly app: number | string;
  readonly query: string;
  readonly fields: readonly string[];
}

export interface RecordsResponse {
  readonly records: readonly KintoneRecord[];
}

export type FetchRecords = (
  request: RecordsRequest,
) => Promise<RecordsResponse>;

export interface KeysetReadOptions {
  readonly app: number | string;
  readonly baseQuery: string;
  readonly fields: readonly string[];
  readonly pageSize?: number;
}

export interface ChunkOptions {
  readonly maxValues?: number;
  readonly maxQueryLength?: number;
}

export interface ChunkedReadOptions extends KeysetReadOptions, ChunkOptions {
  readonly field: string;
  readonly values: readonly string[];
}

function joinCondition(left: string, right: string): string {
  const trimmedLeft = left.trim();
  const trimmedRight = right.trim();
  if (trimmedLeft.length === 0) return trimmedRight;
  if (trimmedRight.length === 0) return trimmedLeft;
  return `(${trimmedLeft}) and ${trimmedRight}`;
}

export function quoteQueryValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function chunkInConditions(
  field: string,
  values: readonly string[],
  options: ChunkOptions = {},
): readonly string[] {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field)) {
    throw new KintoneRecordError(`invalid query field: ${field}`);
  }
  const maxValues = options.maxValues ?? 100;
  const maxQueryLength = options.maxQueryLength ?? 1_000;
  if (!Number.isInteger(maxValues) || maxValues < 1 || maxQueryLength < 1) {
    throw new KintoneRecordError("invalid query chunk limits");
  }
  const unique = [...new Set(values)];
  const chunks: string[][] = [];
  let current: string[] = [];

  for (const value of unique) {
    const quoted = quoteQueryValue(value);
    const candidate = [...current, quoted];
    const condition = `${field} in (${candidate.join(", ")})`;
    if (condition.length > maxQueryLength && current.length === 0) {
      throw new KintoneRecordError("one query value exceeds maxQueryLength");
    }
    if (candidate.length > maxValues || condition.length > maxQueryLength) {
      chunks.push(current);
      current = [quoted];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk) => `${field} in (${chunk.join(", ")})`);
}

export async function readAllByKeyset(
  fetchRecords: FetchRecords,
  options: KeysetReadOptions,
): Promise<readonly KintoneRecord[]> {
  const pageSize = options.pageSize ?? 500;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new KintoneRecordError("pageSize must be an integer from 1 to 500");
  }
  const fields = options.fields.includes("$id")
    ? [...options.fields]
    : [...options.fields, "$id"];
  const records: KintoneRecord[] = [];
  let lastId: bigint | null = null;

  for (;;) {
    const keyset = lastId === null ? "" : `$id > ${lastId.toString()}`;
    const response = await fetchRecords({
      app: options.app,
      query:
        `${joinCondition(options.baseQuery, keyset)} order by $id asc limit ${pageSize}`.trim(),
      fields,
    });
    let pageLastId: bigint | null = lastId;
    for (const record of response.records) {
      const rawId = requiredText(record, "$id");
      if (!/^[1-9][0-9]*$/.test(rawId)) {
        throw new KintoneRecordError(`invalid kintone record ID: ${rawId}`);
      }
      const recordId = BigInt(rawId);
      if (pageLastId !== null && recordId <= pageLastId) {
        throw new KintoneRecordError(
          "$id keyset page is not strictly increasing",
        );
      }
      pageLastId = recordId;
      records.push(record);
    }
    if (response.records.length < pageSize) return records;
    if (pageLastId === lastId) {
      throw new KintoneRecordError("$id keyset page did not advance");
    }
    lastId = pageLastId;
  }
}

export async function readAllByChunks(
  fetchRecords: FetchRecords,
  options: ChunkedReadOptions,
): Promise<readonly KintoneRecord[]> {
  const conditions = chunkInConditions(options.field, options.values, options);
  const records: KintoneRecord[] = [];
  for (const condition of conditions) {
    const chunkRecords = await readAllByKeyset(fetchRecords, {
      app: options.app,
      baseQuery: joinCondition(options.baseQuery, condition),
      fields: options.fields,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
    records.push(...chunkRecords);
  }
  return records;
}
