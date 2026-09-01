import type { PluginConfig } from "./config-validation.js";

export interface FormFieldProperty {
  readonly type?: string;
  readonly referenceTable?: {
    readonly relatedApp?: { readonly app?: string | number };
  };
}

export interface FormFieldsResponse {
  readonly properties?: Readonly<Record<string, FormFieldProperty>>;
}

export interface RelatedAppIds {
  readonly auditAppId: string;
  readonly requestAppId: string;
  readonly logAppId: string;
}

const RELATED_FIELDS = {
  auditAppId: "related_audit_events",
  requestAppId: "related_requests",
  logAppId: "related_job_logs",
} as const;

function relatedAppId(
  properties: FormFieldsResponse["properties"],
  fieldCode: string,
): string {
  const property = properties?.[fieldCode];
  if (property?.type !== "REFERENCE_TABLE") return "";
  const raw = property.referenceTable?.relatedApp?.app;
  const value = typeof raw === "number" ? String(raw) : raw;
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : "";
}

export function detectRelatedAppIds(
  response: FormFieldsResponse,
): RelatedAppIds {
  return {
    auditAppId: relatedAppId(response.properties, RELATED_FIELDS.auditAppId),
    requestAppId: relatedAppId(
      response.properties,
      RELATED_FIELDS.requestAppId,
    ),
    logAppId: relatedAppId(response.properties, RELATED_FIELDS.logAppId),
  };
}

export function resolveRelatedAppIds(
  config: Readonly<Partial<PluginConfig>>,
  detected: RelatedAppIds,
): RelatedAppIds {
  const preferred = (key: keyof RelatedAppIds): string => {
    const configured = config[key];
    return configured !== undefined && configured !== ""
      ? configured
      : detected[key];
  };
  return {
    auditAppId: preferred("auditAppId"),
    requestAppId: preferred("requestAppId"),
    logAppId: preferred("logAppId"),
  };
}
