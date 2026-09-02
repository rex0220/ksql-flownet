import {
  MAX_BUSINESS_KEY_LENGTH,
  type BusinessKeyPolicy,
  type ScheduledPeriodPolicy,
  type ValidationError,
} from "./network-definition.js";

export interface BusinessKeyInput {
  readonly networkId: string;
  readonly policy: BusinessKeyPolicy;
  readonly scheduledFor?: string;
  readonly businessKey?: string;
}

export interface BusinessKeyResult {
  readonly businessKey?: string;
  readonly errors: readonly ValidationError[];
}

interface CalendarDate {
  readonly yyyy: string;
  readonly MM: string;
  readonly dd: string;
}

const ISO_TIMESTAMP_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const ALLOWED_PLACEHOLDERS = new Set([
  "{network_id}",
  "{yyyy}",
  "{MM}",
  "{dd}",
]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return days[month - 1] ?? 0;
}

function parseScheduledFor(value: string): Date | undefined {
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(value);
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  // Intl/Date cannot faithfully represent arbitrary precision or extended
  // years. Reject those forms instead of silently normalizing them.
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return undefined;
  }

  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds)
    ? new Date(epochMilliseconds)
    : undefined;
}

export function normalizeScheduledFor(value: string): string | undefined {
  return parseScheduledFor(value)?.toISOString();
}

function calendarDateAt(date: Date, timeZone: string): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const yyyy = parts.get("year");
  const MM = parts.get("month");
  const dd = parts.get("day");
  if (yyyy === undefined || MM === undefined || dd === undefined) {
    throw new Error("Intl did not return the requested calendar date parts");
  }
  return { yyyy, MM, dd };
}

export function validateScheduledPeriodPolicy(
  policy: ScheduledPeriodPolicy,
): ValidationError[] {
  const errors: ValidationError[] = [];
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: policy.timezone }).format();
  } catch {
    errors.push({
      code: "TIMEZONE_INVALID",
      path: "$.business_key_policy.timezone",
      message: `unknown IANA timezone '${policy.timezone}'`,
    });
  }

  const placeholders: readonly string[] =
    policy.format.match(/\{[^{}]*\}/g) ?? [];
  for (const placeholder of placeholders) {
    if (!ALLOWED_PLACEHOLDERS.has(placeholder)) {
      errors.push({
        code: "FORMAT_PLACEHOLDER_UNSUPPORTED",
        path: "$.business_key_policy.format",
        message: `unsupported placeholder '${placeholder}'`,
      });
    }
  }
  const remainder = placeholders.reduce(
    (value, placeholder) => value.replace(placeholder, ""),
    policy.format,
  );
  if (remainder.includes("{") || remainder.includes("}")) {
    errors.push({
      code: "FORMAT_PLACEHOLDER_INVALID",
      path: "$.business_key_policy.format",
      message: "contains an invalid placeholder expression",
    });
  }

  // A period label must retain every coarser calendar component; otherwise
  // different days, months, or years could collapse to the same key.
  const required: readonly string[] =
    policy.period === "day" ? ["{yyyy}", "{MM}", "{dd}"] : ["{yyyy}", "{MM}"];
  for (const placeholder of required) {
    if (!placeholders.includes(placeholder)) {
      errors.push({
        code: "FORMAT_PERIOD_MISMATCH",
        path: "$.business_key_policy.format",
        message: `period '${policy.period}' requires placeholder '${placeholder}'`,
      });
    }
  }
  // Phase 1 month keys represent a normalized month boundary. Including a day
  // would make the same month depend on the scheduled day, so fail closed.
  if (policy.period === "month" && placeholders.includes("{dd}")) {
    errors.push({
      code: "FORMAT_PERIOD_MISMATCH",
      path: "$.business_key_policy.format",
      message: "period 'month' must not use placeholder '{dd}'",
    });
  }
  return errors;
}

function validateBusinessKey(value: string, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (value.length === 0) {
    errors.push({
      code: "BUSINESS_KEY_EMPTY",
      path,
      message: "must not be empty",
    });
  }
  if (value.length > MAX_BUSINESS_KEY_LENGTH) {
    errors.push({
      code: "BUSINESS_KEY_TOO_LONG",
      path,
      message: `must be at most ${MAX_BUSINESS_KEY_LENGTH} characters`,
    });
  }
  if (hasControlCharacter(value)) {
    errors.push({
      code: "BUSINESS_KEY_CONTROL_CHARACTER",
      path,
      message: "must not contain NUL, newline, or other control characters",
    });
  }
  return errors;
}

export function resolveBusinessKey(input: BusinessKeyInput): BusinessKeyResult {
  const errors: ValidationError[] = [];

  if (input.policy.type === "explicit") {
    if (input.scheduledFor !== undefined) {
      errors.push({
        code: "SCHEDULED_FOR_NOT_ALLOWED",
        path: "--scheduled-for",
        message: "is not allowed when business_key_policy.type is 'explicit'",
      });
    }
    if (input.businessKey === undefined) {
      errors.push({
        code: "BUSINESS_KEY_REQUIRED",
        path: "--business-key",
        message: "is required when business_key_policy.type is 'explicit'",
      });
      return { errors };
    }
    errors.push(...validateBusinessKey(input.businessKey, "--business-key"));
    return errors.length === 0
      ? { businessKey: input.businessKey, errors }
      : { errors };
  }

  const policyErrors = validateScheduledPeriodPolicy(input.policy);
  errors.push(...policyErrors);
  const { businessKey: providedBusinessKey, scheduledFor: scheduledForInput } =
    input;
  if (scheduledForInput === undefined) {
    if (providedBusinessKey === undefined) {
      errors.push({
        code: "SCHEDULED_FOR_REQUIRED",
        path: "--scheduled-for/--business-key",
        message:
          "either --scheduled-for or --business-key is required when business_key_policy.type is 'scheduled_period'",
      });
      return { errors };
    }
    errors.push(...validateBusinessKey(providedBusinessKey, "--business-key"));
    return errors.length === 0
      ? { businessKey: providedBusinessKey, errors }
      : { errors };
  }

  const scheduledFor = parseScheduledFor(scheduledForInput);
  if (scheduledFor === undefined) {
    errors.push({
      code: "SCHEDULED_FOR_INVALID",
      path: "--scheduled-for",
      message: "must be a valid ISO 8601 timestamp with an explicit offset",
    });
    return { errors };
  }
  if (policyErrors.length > 0) return { errors };

  if (providedBusinessKey !== undefined) {
    errors.push(...validateBusinessKey(providedBusinessKey, "--business-key"));
    return errors.length === 0
      ? { businessKey: providedBusinessKey, errors }
      : { errors };
  }

  let calendarDate: CalendarDate;
  try {
    calendarDate = calendarDateAt(scheduledFor, input.policy.timezone);
  } catch {
    errors.push({
      code: "TIMEZONE_INVALID",
      path: "$.business_key_policy.timezone",
      message: `unknown IANA timezone '${input.policy.timezone}'`,
    });
    return { errors };
  }
  const replacements: Readonly<Record<string, string>> = {
    "{network_id}": input.networkId,
    "{yyyy}": calendarDate.yyyy,
    "{MM}": calendarDate.MM,
    // A month policy is normalized to its month boundary. Validation forbids
    // {dd} for month, while using "01" here keeps this function total if an
    // already-validated policy is accidentally bypassed.
    "{dd}": input.policy.period === "month" ? "01" : calendarDate.dd,
  };
  const businessKey = input.policy.format.replace(
    /\{[^{}]*\}/g,
    (placeholder) => replacements[placeholder] ?? placeholder,
  );
  errors.push(
    ...validateBusinessKey(businessKey, "$.business_key_policy.format"),
  );
  return errors.length === 0 ? { businessKey, errors } : { errors };
}
