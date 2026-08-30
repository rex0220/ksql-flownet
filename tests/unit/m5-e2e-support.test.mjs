import assert from "node:assert/strict";
import test from "node:test";

import { assertDistinctProcessCwds, m5ConfirmedBy } from "../e2e/support.mjs";

test("M5 lock conflict rejects an identical standalone cwd", () => {
  assert.throws(
    () => assertDistinctProcessCwds("C:\\work\\flownet", "C:\\work\\flownet"),
    /異なるcwd/u,
  );
});

test("M5 lock conflict accepts distinct process cwd values", () => {
  assert.doesNotThrow(() =>
    assertDistinctProcessCwds(
      "C:\\work\\flownet",
      "C:\\work\\flownet-e2e-standalone",
    ),
  );
});

test("kill cleanup confirmed-by accepts argument then environment", () => {
  assert.equal(
    m5ConfirmedBy({ M5_FORCE_UNLOCK_CONFIRMED_BY: "environment-user" }, [
      "--confirmed-by",
      "argument-user",
    ]),
    "argument-user",
  );
  assert.equal(
    m5ConfirmedBy({ M5_FORCE_UNLOCK_CONFIRMED_BY: "environment-user" }, []),
    "environment-user",
  );
  assert.throws(() => m5ConfirmedBy({}, []), /confirmed-by/u);
});
