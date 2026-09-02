import {
  normalizeScheduledFor,
  resolveBusinessKey,
} from "../domain/business-key.js";
import { loadNetworkDefinition } from "../domain/load-network.js";
import type { NetworkDefinition } from "../domain/network-definition.js";
import type { RequestResult } from "./kintone-request-store.js";
import type { PollRequestsNetwork } from "./poll-requests-config.js";
import type { RequestRecord } from "./request-model.js";

export type StartNetworkInput =
  | { readonly businessKey: string; readonly scheduledFor?: string }
  | { readonly scheduledFor: string; readonly businessKey?: string };

export interface PreparedStartRequest {
  readonly definition: NetworkDefinition;
  readonly businessKey: string;
  readonly input: StartNetworkInput;
}

export type StartPreparation =
  | { readonly ok: true; readonly value: PreparedStartRequest }
  | { readonly ok: false; readonly result: RequestResult };

export function prepareStartRequest(
  network: PollRequestsNetwork,
  request: Pick<RequestRecord, "businessKey" | "scheduledFor">,
): StartPreparation {
  const loaded = loadNetworkDefinition(network.definitionPath);
  if (
    loaded.definition === undefined &&
    loaded.errors.some(
      ({ path, message }) =>
        path.startsWith("$/nodes/") &&
        message.includes("required property 'idempotent'"),
    )
  ) {
    return failure(
      "NETWORK_NOT_IDEMPOTENT",
      "全ノードの冪等性が確認できないためSTARTでは起動できません。",
    );
  }
  if (
    loaded.definition === undefined ||
    loaded.errors.length > 0 ||
    loaded.definition.network_id !== network.networkId
  ) {
    return failure(
      "NETWORK_DEFINITION_INVALID",
      "network定義を再読込できないため起動できません。二次対応者へ連絡してください。",
    );
  }
  const definition = loaded.definition;
  if (definition.nodes.some((node) => node.idempotent !== true)) {
    return failure(
      "NETWORK_NOT_IDEMPOTENT",
      "全ノードの冪等性が確認できないためSTARTでは起動できません。",
    );
  }

  const businessKey = request.businessKey ?? undefined;
  const scheduledForInput = request.scheduledFor ?? undefined;
  if (definition.business_key_policy.type === "explicit") {
    if (businessKey === undefined || scheduledForInput !== undefined) {
      return failure(
        "KEY_POLICY_MISMATCH",
        "networkの業務キー規則と入力内容が一致しません。",
      );
    }
    const resolved = resolveBusinessKey({
      networkId: definition.network_id,
      policy: definition.business_key_policy,
      businessKey,
    });
    if (resolved.businessKey === undefined || resolved.errors.length > 0) {
      return failure(
        "KEY_POLICY_MISMATCH",
        "networkの業務キー規則と入力内容が一致しません。",
      );
    }
    return {
      ok: true,
      value: {
        definition,
        businessKey: resolved.businessKey,
        input: { businessKey: resolved.businessKey },
      },
    };
  }

  if (businessKey === undefined && scheduledForInput === undefined) {
    return failure(
      "KEY_POLICY_MISMATCH",
      "networkの業務キー規則と入力内容が一致しません。",
    );
  }
  if (businessKey !== undefined && scheduledForInput === undefined) {
    return failure(
      "AS_OF_UNDEFINED",
      "補正用business_keyには対象期間のscheduled_forも指定してください。",
    );
  }
  const scheduledFor = normalizeScheduledFor(scheduledForInput!);
  if (scheduledFor === undefined) {
    return failure(
      "INVALID_TIMESTAMP_FORMAT",
      "scheduled_forは実在する日時を明示offset付きで指定してください。",
    );
  }
  const resolved = resolveBusinessKey({
    networkId: definition.network_id,
    policy: definition.business_key_policy,
    scheduledFor,
    ...(businessKey === undefined ? {} : { businessKey }),
  });
  if (resolved.businessKey === undefined || resolved.errors.length > 0) {
    return failure(
      "KEY_POLICY_MISMATCH",
      "networkの業務キー規則と入力内容が一致しません。",
    );
  }
  return {
    ok: true,
    value: {
      definition,
      businessKey: resolved.businessKey,
      input: {
        scheduledFor,
        ...(businessKey === undefined ? {} : { businessKey }),
      },
    },
  };
}

export function startNetworkNotAllowed(
  detail: "NOT_IN_ALLOWLIST" | "APP_START_DISABLED",
): RequestResult {
  return {
    state: "REJECTED",
    code: "NETWORK_NOT_ALLOWED",
    message: `このnetworkはSTARTで起動できません。detail=${detail}`,
  };
}

function failure(code: string, message: string): StartPreparation {
  return { ok: false, result: { state: "REJECTED", code, message } };
}
