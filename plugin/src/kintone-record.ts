export interface KintoneField {
  readonly value: unknown;
}

export type KintoneRecord = Readonly<Record<string, KintoneField>>;

export class KintoneRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KintoneRecordError";
  }
}

export function fieldValue(record: KintoneRecord, code: string): unknown {
  if (!Object.hasOwn(record, code)) {
    throw new KintoneRecordError(`missing kintone field: ${code}`);
  }
  const field = record[code];
  if (
    field === undefined ||
    typeof field !== "object" ||
    field === null ||
    !Object.hasOwn(field, "value")
  ) {
    throw new KintoneRecordError(`invalid kintone field wrapper: ${code}`);
  }
  return field.value;
}

export function requiredText(record: KintoneRecord, code: string): string {
  const value = fieldValue(record, code);
  if (typeof value !== "string" || value.length === 0) {
    throw new KintoneRecordError(
      `kintone field must be non-empty text: ${code}`,
    );
  }
  return value;
}

export function nullableText(
  record: KintoneRecord,
  code: string,
): string | null {
  const value = fieldValue(record, code);
  if (typeof value !== "string") {
    throw new KintoneRecordError(`kintone field must be text: ${code}`);
  }
  return value === "" ? null : value;
}

export function nonnegativeInteger(
  record: KintoneRecord,
  code: string,
): number {
  const value = requiredText(record, code);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new KintoneRecordError(
      `kintone field must be a non-negative integer: ${code}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new KintoneRecordError(
      `kintone integer is outside safe range: ${code}`,
    );
  }
  return parsed;
}

export function requireLiteral<T extends string>(
  record: KintoneRecord,
  code: string,
  allowed: readonly T[],
): T {
  const value = requiredText(record, code);
  if (!allowed.includes(value as T)) {
    throw new KintoneRecordError(`invalid ${code}: ${value}`);
  }
  return value as T;
}
