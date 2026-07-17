import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlank, mergeRecordFields, foldMonths } from "./merge-months.mjs";

test("isBlank treats null, undefined, and zero as blank", () => {
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank(0), true);
  assert.equal(isBlank(42), false);
});

test("isBlank treats an object as blank only when every value is blank", () => {
  assert.equal(isBlank({ rental: 0, other: 0, total: 0 }), true);
  assert.equal(isBlank({ rental: 100, other: 0, total: 100 }), false);
});

test("mergeRecordFields keeps the old value when the new one is blank", () => {
  const merged = mergeRecordFields({ occupancyPct: 84.4, noi: 100 }, { occupancyPct: null, noi: 200 });
  assert.equal(merged.occupancyPct, 84.4);
  assert.equal(merged.noi, 200);
});

test("mergeRecordFields returns the new record whole when there is no old record", () => {
  const merged = mergeRecordFields(undefined, { occupancyPct: 74, noi: 50 });
  assert.deepEqual(merged, { occupancyPct: 74, noi: 50 });
});

test("foldMonths lets a later batch's blank occupancy fall back to an earlier batch's value", () => {
  const batchOld = new Map([["2026-01", { occupancyPct: 84.4, income: { total: 100 } }]]);
  const batchNew = new Map([["2026-01", { occupancyPct: null, income: { total: 150 } }]]);
  const result = foldMonths([batchOld, batchNew]);
  assert.equal(result.get("2026-01").occupancyPct, 84.4);
  assert.equal(result.get("2026-01").income.total, 150);
});

test("foldMonths folds three batches in order, each contributing new months", () => {
  const b1 = new Map([["2025-01", { noi: 10 }]]);
  const b2 = new Map([["2025-02", { noi: 20 }]]);
  const b3 = new Map([["2025-01", { noi: 15 }]]);
  const result = foldMonths([b1, b2, b3]);
  assert.equal(result.get("2025-01").noi, 15);
  assert.equal(result.get("2025-02").noi, 20);
});
