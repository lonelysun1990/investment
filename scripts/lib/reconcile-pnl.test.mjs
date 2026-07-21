import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcilePnlRecord } from "./reconcile-pnl.mjs";

test("reconciled record with matching arithmetic produces no notes", () => {
  const record = {
    income: { rental: 20000, other: 1000, total: 21000 },
    expense: { total: 10000 },
    noi: 11000,
    nonOperatingExpense: { debtService: 5000, otherNonOperating: 0, capitalImprovements: 2000, total: 7000 },
    netIncome: 4000,
  };
  const result = reconcilePnlRecord(record);
  assert.equal(result.reconciled, true);
  assert.deepEqual(result.notes, []);
});

test("flags a NOI mismatch with a specific note naming both sides", () => {
  const record = {
    income: { rental: 20000, other: 1000, total: 21000 },
    expense: { total: 10000 },
    noi: 999,
    nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
    netIncome: 999,
  };
  const result = reconcilePnlRecord(record);
  assert.equal(result.reconciled, false);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /NOI mismatch/);
  assert.match(result.notes[0], /21000/);
  assert.match(result.notes[0], /10000/);
  assert.match(result.notes[0], /999/);
});

test("flags a net income mismatch independently of NOI", () => {
  const record = {
    income: { rental: 20000, other: 1000, total: 21000 },
    expense: { total: 10000 },
    noi: 11000,
    nonOperatingExpense: { debtService: 5000, otherNonOperating: 0, capitalImprovements: 2000, total: 7000 },
    netIncome: 0,
  };
  const result = reconcilePnlRecord(record);
  assert.equal(result.reconciled, false);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /Net income mismatch/);
});

test("can flag both mismatches at once", () => {
  const record = {
    income: { rental: 20000, other: 1000, total: 21000 },
    expense: { total: 10000 },
    noi: 999,
    nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
    netIncome: 0,
  };
  const result = reconcilePnlRecord(record);
  assert.equal(result.reconciled, false);
  assert.equal(result.notes.length, 2);
});

test("tolerates rounding differences within $1", () => {
  const record = {
    income: { rental: 20000, other: 1000, total: 21000 },
    expense: { total: 10000.4 },
    noi: 10999.7,
    nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
    netIncome: 10999.7,
  };
  const result = reconcilePnlRecord(record);
  assert.equal(result.reconciled, true);
});

test("does not flag a record with null noi/netIncome (incomplete-by-design, not a mismatch)", () => {
  const record = {
    income: null,
    expense: null,
    noi: null,
    nonOperatingExpense: null,
    netIncome: null,
    occupancyPct: 84.4,
  };
  const result = reconcilePnlRecord(record);
  assert.equal(result.reconciled, true);
  assert.deepEqual(result.notes, []);
});
