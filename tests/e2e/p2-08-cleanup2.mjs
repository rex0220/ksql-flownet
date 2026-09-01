/* 実キー列挙による全E2E残置Runの清掃(likeの完全一致挙動対応・一時スクリプト) */
import { join } from "node:path";

import {
  cleanupM5Records,
  getAllPersistenceRecords,
  field,
  requireM5Environment,
} from "./support.mjs";

const base = requireM5Environment();
const settings = { ...base, workdir: join(base.workdirBase, "p208-cleanup2") };

const runs = await getAllPersistenceRecords(
  settings,
  "state",
  `record_type in ("NETWORK_RUN")`,
);
const keys = [...new Set(runs.map((r) => field(r, "business_key")))].filter(
  (k) => k.startsWith("KSQL_FLOW_TEST_"),
);
console.log(`対象business_key: ${keys.length}件`);
let state = 0;
let audit = 0;
for (const key of keys) {
  const result = await cleanupM5Records(settings, key);
  state += result.state;
  audit += result.audit;
}
console.log(`削除合計: state=${state} audit=${audit}`);
const rest = await getAllPersistenceRecords(
  settings,
  "state",
  `record_type in ("NETWORK_RUN")`,
);
console.log(`残NETWORK_RUN: ${rest.length}件`);
