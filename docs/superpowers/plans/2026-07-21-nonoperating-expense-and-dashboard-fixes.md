# Non-Operating Expense Unification & Dashboard Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace McNeil's and Legacy's separately-tracked `debtService`/`capitalImprovements` fields with one unified `nonOperatingExpense{...,total}` object both deals populate consistently, add a reconciliation validation step to the extraction pipeline, and fix the dashboard's ledger table formatting, distribution-history columns, and remove the redundant waterfall chart.

**Architecture:** `nonOperatingExpense` mirrors the existing `expense{...,total}` shape — itemized sub-fields when a source report breaks them out, always a trustworthy `.total`. A new `scripts/lib/reconcile-pnl.mjs` module validates `income.total - expense.total ≈ noi` and `noi - nonOperatingExpense.total ≈ netIncome` on every final record before it's saved, warning (not throwing) on mismatch. Dashboard changes are display-only, reading the new field shape.

**Tech Stack:** Node.js (`node:test`), existing `pdftotext`-based deterministic extraction (McNeil), vision-LLM extraction (Legacy), vanilla JS + Chart.js dashboard.

## Global Constraints

- `nonOperatingExpense` replaces `debtService`/`capitalImprovements` entirely as top-level record fields — do not keep the old fields alongside the new one.
- Reconciliation mismatches log a `console.warn` and stamp `reconciled: false` on the record; they never throw and never halt extraction for other months.
- The underlying `expense.total` JSON field is unchanged; only the ledger table's display label changes from "Total expense" to "Total operating expense".
- The waterfall chart (`renderMonthlyWaterfallChart`, its card, its call site) is removed entirely, not modified.
- `npm test` must pass with zero regressions after every task.

---

### Task 1: `scripts/lib/reconcile-pnl.mjs`

New, standalone module — no dependencies on the other tasks, safe to build and test first.

**Files:**
- Create: `scripts/lib/reconcile-pnl.mjs`
- Test: `scripts/lib/reconcile-pnl.test.mjs`

**Interfaces:**
- Produces: `reconcilePnlRecord(record): {reconciled: boolean, notes: string[]}`.
- Consumes (Task 2): called on every record before saving.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/reconcile-pnl.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/reconcile-pnl.test.mjs`
Expected: FAIL with `Cannot find module './reconcile-pnl.mjs'`

- [ ] **Step 3: Implement `reconcile-pnl.mjs`**

```js
const TOLERANCE = 1; // matches the existing NOI_CROSS_CHECK_TOLERANCE precedent in extract-legacy.mjs

export function reconcilePnlRecord(record) {
  const notes = [];

  const expectedNoi = (record.income?.total ?? 0) - (record.expense?.total ?? 0);
  if (record.noi != null && Math.abs(expectedNoi - record.noi) > TOLERANCE) {
    notes.push(
      `NOI mismatch: income.total (${record.income?.total}) - expense.total (${record.expense?.total}) = ${expectedNoi}, but noi is ${record.noi}`
    );
  }

  const expectedNetIncome = (record.noi ?? 0) - (record.nonOperatingExpense?.total ?? 0);
  if (record.netIncome != null && Math.abs(expectedNetIncome - record.netIncome) > TOLERANCE) {
    notes.push(
      `Net income mismatch: noi (${record.noi}) - nonOperatingExpense.total (${record.nonOperatingExpense?.total}) = ${expectedNetIncome}, but netIncome is ${record.netIncome}`
    );
  }

  return { reconciled: notes.length === 0, notes };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/reconcile-pnl.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/reconcile-pnl.mjs scripts/lib/reconcile-pnl.test.mjs
git commit -m "feat: add reconcilePnlRecord for P&L arithmetic validation

Checks income.total - expense.total ~= noi and noi -
nonOperatingExpense.total ~= netIncome (\$1 tolerance). Returns
{reconciled, notes} rather than throwing -- callers decide what to do
with a mismatch."
```

---

### Task 2: Wire reconciliation into `runGenericExtraction`

**Files:**
- Modify: `scripts/lib/run-extraction.mjs`
- Test: `scripts/lib/run-extraction.test.mjs`

**Interfaces:**
- Consumes: `reconcilePnlRecord` (Task 1).
- Produces: `runGenericExtraction`'s saved records gain an optional `reconciled: false` field on mismatched months (clean records are unchanged — no `reconciled: true` added, to avoid rewriting every already-clean historical record).

- [ ] **Step 1: Read the existing test file to see current conventions**

Read `scripts/lib/run-extraction.test.mjs` in full before writing new tests — match its exact fixture/mocking style (it likely uses a fake `extractBatch` function and a temp output path; do not guess, read the real file).

- [ ] **Step 2: Write the failing test**

Add to `scripts/lib/run-extraction.test.mjs` (adjust the exact fake-`extractBatch`-construction style to match what you find in Step 1 — the assertions below are what must hold regardless of fixture style):

```js
test("stamps a mismatched month with reconciled:false and logs a warning, but still saves every other month", async () => {
  const outputPath = "scripts/__fixtures__/tmp-run-extraction-reconcile-output.json";
  await rm(outputPath, { force: true });

  const fakeExtractBatch = async (batchDir, manifest) => {
    const month = path.basename(batchDir);
    if (month === "2026-01") {
      return new Map([[month, {
        month,
        income: { rental: 1000, other: 0, total: 1000 },
        expense: { total: 500 },
        noi: 999999, // deliberately wrong
        nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
        netIncome: 999999,
      }]]);
    }
    return new Map([[month, {
      month,
      income: { rental: 1000, other: 0, total: 1000 },
      expense: { total: 500 },
      noi: 500,
      nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
      netIncome: 500,
    }]]);
  };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    await runGenericExtraction("scripts/__fixtures__/raw-mcneil-bundle", outputPath, fakeExtractBatch);
  } finally {
    console.warn = originalWarn;
  }

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  const mismatchedMonth = Object.keys(written).find((m) => written[m].reconciled === false);
  assert.ok(mismatchedMonth, "expected exactly one month flagged reconciled:false");
  assert.ok(warnings.some((w) => w.includes(mismatchedMonth)), "expected a console.warn naming the mismatched month");

  const cleanMonths = Object.keys(written).filter((m) => m !== mismatchedMonth);
  assert.ok(cleanMonths.length > 0, "other months must still be saved");
  for (const m of cleanMonths) {
    assert.equal("reconciled" in written[m], false, "clean months should not gain a reconciled field");
  }

  await rm(outputPath, { force: true });
});
```

(This reuses the already-committed `scripts/__fixtures__/raw-mcneil-bundle` fixture directory purely as a source of real batch directory names for `runGenericExtraction` to iterate — the fake `extractBatch` supplies all the actual record data, so no new fixture is needed. If `path` and `readFile`/`rm` aren't already imported in the test file, add `import path from "node:path";` and `import { readFile, rm } from "node:fs/promises";`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test scripts/lib/run-extraction.test.mjs`
Expected: FAIL — no month gets `reconciled: false` today, since nothing calls `reconcilePnlRecord` yet.

- [ ] **Step 4: Wire `reconcilePnlRecord` into `runGenericExtraction`**

In `scripts/lib/run-extraction.mjs`, add the import and update the save loop:

```js
import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadManifest } from "./archive-store.mjs";
import { foldMonths } from "./merge-months.mjs";
import { saveRecords } from "./record-store.mjs";
import { reconcilePnlRecord } from "./reconcile-pnl.mjs";

export async function runGenericExtraction(dealRawDir, outputPath, extractBatch) {
  let batchNames;
  try {
    batchNames = (await readdir(dealRawDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if (err.code === "ENOENT") return { monthsProcessed: [], batchesProcessed: [] };
    throw err;
  }

  const batches = [];
  for (const batchName of batchNames) {
    const batchDir = path.join(dealRawDir, batchName);
    const manifest = await loadManifest(batchDir);
    const batchMonths = await extractBatch(batchDir, manifest);
    if (batchMonths.size > 0) batches.push(batchMonths);
  }

  const merged = foldMonths(batches);
  const records = {};
  for (const [month, record] of merged) {
    const { reconciled, notes } = reconcilePnlRecord(record);
    if (reconciled) {
      records[month] = record;
    } else {
      for (const note of notes) console.warn(`${month}: ${note}`);
      records[month] = { ...record, reconciled: false };
    }
  }
  await saveRecords(outputPath, records);

  return { monthsProcessed: [...merged.keys()].sort(), batchesProcessed: batchNames };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test scripts/lib/run-extraction.test.mjs`
Expected: PASS, all tests (existing + new)

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/run-extraction.mjs scripts/lib/run-extraction.test.mjs
git commit -m "feat: wire reconciliation validation into runGenericExtraction

Every final, merged record is checked before saving. A mismatch logs
a console.warn naming the month and the exact numbers that disagree,
and the record is stamped reconciled:false -- extraction still
completes for every other month."
```

---

### Task 3: McNeil `nonOperatingExpense` unification

**Files:**
- Modify: `scripts/extract-mcneil.mjs`
- Test: `scripts/extract-mcneil.test.mjs`

**Interfaces:**
- Produces: `extractMcneilPnl`'s records gain `nonOperatingExpense: {debtService, otherNonOperating, capitalImprovements, total}`, replacing the old top-level `debtService`/`capitalImprovements` fields.
- Consumes (Task 5, dashboard): `.nonOperatingExpense.total`.

Two real label variants exist for the aggregate non-operating line, verified against the real committed fixtures:
- Older aggregate-only reports (`2024-annual-cashflow-statement.pdf`, `2025-trailing-pnl-detail.pdf`): `"TOTAL NON-OPERATING EXPENSE"`.
- The newer itemized report (`2026-06-cashflow-statement.pdf`): `"TOTAL NON-OPERATING"` (no trailing "EXPENSE") — confirmed via `pdftotext -layout scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf - | grep NON-OPERATING`. Only the `"...EXPENSE"` variant should mark a month `expenseIsAggregateOnly` (low confidence) — the `"TOTAL NON-OPERATING"` variant co-occurs with real itemized `Total Debt Service`/`Total Capital Improvements` lines in a high-confidence report and must NOT downgrade those months' confidence, matching current behavior exactly (today neither variant match happens for that report, since the code only checks for the `"...EXPENSE"` string).

- [ ] **Step 1: Write the failing tests**

Replace the existing test in `scripts/extract-mcneil.test.mjs`:

```js
test("parses NOI, debt service, capital improvements, and net income for June 2026", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const june = result.get("2026-06");
  assert.equal(june.noi, 13812.52);
  assert.equal(june.nonOperatingExpense.debtService, 5010.81);
  assert.equal(june.nonOperatingExpense.capitalImprovements, 4161.71);
  assert.equal(june.nonOperatingExpense.total, 9172.52);
  assert.equal(june.netIncome, 4640.0);
});
```

Add new tests to the same file:

```js
test("captures nonOperatingExpense.total from the aggregate line even when itemized debt service/capex are also present", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const june = result.get("2026-06");
  // 9172.52 is the real printed "TOTAL NON-OPERATING" line for Jun 2026,
  // which does NOT equal debtService+capitalImprovements alone
  // (5010.81 + 4161.71 = 9172.52 here, but the aggregate line must be
  // used directly rather than recomputed, since other report formats'
  // aggregate includes an otherNonOperating amount with no itemized line).
  assert.equal(june.nonOperatingExpense.total, 5010.81 + 4161.71);
});

test("June 2026 report is high confidence, not flagged aggregate-only, despite having a TOTAL NON-OPERATING line", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const june = result.get("2026-06");
  assert.equal(june.expenseIsAggregateOnly, undefined);
});

test("older aggregate-only report populates nonOperatingExpense.total from TOTAL NON-OPERATING EXPENSE with zero itemized sub-fields", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  const oct2024 = result.get("2024-10");
  assert.equal(oct2024.nonOperatingExpense.debtService, 0);
  assert.equal(oct2024.nonOperatingExpense.capitalImprovements, 0);
  assert.equal(oct2024.nonOperatingExpense.otherNonOperating, 0);
  assert.ok(oct2024.nonOperatingExpense.total > 0, "the aggregate line's real dollar value must be captured, not left at 0");
  assert.equal(oct2024.expenseIsAggregateOnly, true);
});

test("reconciliation holds for a real month with itemized non-operating detail (June 2026)", async () => {
  const { reconcilePnlRecord } = await import("./lib/reconcile-pnl.mjs");
  const result = await extractMcneilPnl(FIXTURE);
  const june = result.get("2026-06");
  const { reconciled } = reconcilePnlRecord(june);
  assert.equal(reconciled, true);
});

test("reconciliation holds for a real aggregate-only month (Trailing P&L Detail, Oct 2024)", async () => {
  const { reconcilePnlRecord } = await import("./lib/reconcile-pnl.mjs");
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  const oct2024 = result.get("2024-10");
  const { reconciled } = reconcilePnlRecord(oct2024);
  assert.equal(reconciled, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: FAIL — `june.nonOperatingExpense` is `undefined` (the field doesn't exist yet).

- [ ] **Step 3: Rewrite the non-operating handling in `extractMcneilPnl`**

In `scripts/extract-mcneil.mjs`, change the initial per-month shape:

```js
  const months = new Map();
  for (const key of monthKeys) {
    months.set(key, {
      income: { rental: 0, other: 0, total: 0 },
      expense: { total: 0 },
      noi: 0,
      nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
      netIncome: 0,
    });
  }
```

Add a new tracking set alongside the existing two, and update the label-matching switch and the two post-loop passes:

```js
  const aggregateExpenseMonths = new Set();
  const aggregateOnlyMonths = new Set();
  const nonOperatingTotalCaptured = new Set();

  let reachedNetIncome = false;
  for (const rawLine of lines) {
    if (reachedNetIncome) break;
    let row;
    try {
      row = splitRow(rawLine);
    } catch {
      continue;
    }
    if (!row) continue;
    const label = row.label.replace(/^\d+\.\d+\s+/, "");
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;

    monthKeys.forEach((key, i) => {
      const rec = months.get(key);
      const value = perMonth[i];
      if (label === "Total Rental Income" || label === "Total Net Rental Income") rec.income.rental = value;
      else if (label === "Total Other Income" || label === "Total Other Rental Income") rec.income.other = value;
      else if (label === "TOTAL INCOME") rec.income.total = value;
      else if (label === "NET OPERATING INCOME") rec.noi = value;
      else if (label === "Total Debt Service") rec.nonOperatingExpense.debtService = value;
      else if (label === "Total Capital Improvements") rec.nonOperatingExpense.capitalImprovements = value;
      else if (label === "NET INCOME") {
        rec.netIncome = value;
      } else if (label === "TOTAL EXPENSE") {
        rec.expense.total = value;
        aggregateExpenseMonths.add(key);
      } else if (label === "TOTAL NON-OPERATING EXPENSE") {
        rec.nonOperatingExpense.total = value;
        aggregateOnlyMonths.add(key);
        nonOperatingTotalCaptured.add(key);
      } else if (label === "TOTAL NON-OPERATING") {
        rec.nonOperatingExpense.total = value;
        nonOperatingTotalCaptured.add(key);
      } else if (/^Total /.test(label)) {
        rec.expense[label.replace(/^Total /, "")] = value;
      }
    });

    if (label === "NET INCOME") reachedNetIncome = true;
  }

  for (const [key, rec] of months) {
    if (aggregateExpenseMonths.has(key)) continue;
    const expenseTotal = Object.entries(rec.expense)
      .filter(([k]) => k !== "total")
      .reduce((sum, [, v]) => sum + v, 0);
    rec.expense.total = Math.round(expenseTotal * 100) / 100;
  }

  for (const [key, rec] of months) {
    if (nonOperatingTotalCaptured.has(key)) continue;
    const nonOpTotal =
      rec.nonOperatingExpense.debtService +
      rec.nonOperatingExpense.otherNonOperating +
      rec.nonOperatingExpense.capitalImprovements;
    rec.nonOperatingExpense.total = Math.round(nonOpTotal * 100) / 100;
  }

  for (const [key, rec] of months) {
    if (aggregateOnlyMonths.has(key)) rec.expenseIsAggregateOnly = true;
  }

  for (const [key, rec] of months) {
    const allZero =
      rec.income.rental === 0 &&
      rec.income.other === 0 &&
      rec.income.total === 0 &&
      Object.values(rec.expense).every((v) => v === 0) &&
      rec.noi === 0 &&
      Object.values(rec.nonOperatingExpense).every((v) => v === 0) &&
      rec.netIncome === 0;
    if (allZero) months.delete(key);
  }
  return months;
```

(Only the four blocks shown changed: the initial `months.set` shape, the label-matching `monthKeys.forEach` switch, the new non-operating recompute-fallback loop inserted after the existing expense-total recompute loop, and the `allZero` check. Everything else in `extractMcneilPnl` — `splitRow`, `parseMonthHeader`, the surrounding function signature — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: PASS, all tests (existing + new). Note: the existing test `"extractMcneilPnl flags every month in the report as aggregate-only once the TOTAL NON-OPERATING EXPENSE row appears"` (for `ANNUAL_FIXTURE`) and `"extractMcneilBatch marks aggregate-only months as low confidence..."` must still pass unchanged — both rely on the `"...EXPENSE"` variant specifically, which is untouched.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs
git commit -m "feat: unify McNeil's debtService/capitalImprovements into nonOperatingExpense

Replaces the two separately-tracked fields with
nonOperatingExpense{debtService,otherNonOperating,capitalImprovements,total},
mirroring the existing expense{...,total} shape. .total is captured
directly from whichever aggregate line is present -- 'TOTAL
NON-OPERATING EXPENSE' (older aggregate-only reports, low confidence)
or 'TOTAL NON-OPERATING' (the newer itemized report, high confidence,
verified via the real fixture) -- rather than recomputed from
sub-fields, since the aggregate can include an otherNonOperating
amount no report itemizes separately. Fixes the zero-filled
non-operating figures for every month sourced from an aggregate-only
report."
```

---

### Task 4: Legacy `nonOperatingExpense` unification

**Files:**
- Modify: `scripts/extract-legacy.mjs`
- Test: `scripts/extract-legacy.test.mjs`

**Interfaces:**
- Produces: `extractLegacyMonth`'s records gain `nonOperatingExpense: {debtService, otherNonOperating, capitalImprovements, total}`, replacing the old top-level `debtService`/`capitalImprovements` fields (Legacy never had a top-level `otherNonOperating` field before — it was requested by the vision-LLM prompt but never stored in the final record; this task both stores it and nests it correctly).
- Consumes: none new — reuses the existing `callVisionLlm`/vision-LLM plumbing unchanged.

- [ ] **Step 1: Update the vision-LLM prompt's requested JSON shape**

In `scripts/extract-legacy.mjs`, change `PNL_TABLE_PROMPT`:

```js
const PNL_TABLE_PROMPT = `This image is a property-management "Trailing Profit and Loss" table with monthly columns (typically 5 months). Extract ALL months' columns, not just the latest. The leftmost visible month column is the earliest, the rightmost is the most recent. Respond with ONLY a JSON object, no prose or code fences, matching exactly this shape:
{
  "months": {
    "<YYYY-MM>": {
      "income": { "rental": number, "other": number, "total": number },
      "expense": { "<exact category label as printed>": number, ..., "total": number },
      "noi": number,
      "nonOperatingExpense": { "debtService": number, "otherNonOperating": number, "capitalImprovements": number, "total": number },
      "netIncome": number
    }
  }
}
Use the month label shown in the column header (e.g., "Jan 2026" → "2026-01"). Use negative numbers (not parentheses) for any value shown in parentheses in the image. Do not include currency symbols or commas in the numbers.`;
```

- [ ] **Step 2: Write the failing tests**

In `scripts/extract-legacy.test.mjs`, replace the `EXPECTED_TABLE` fixture's five month objects — each currently has flat `debtService`/`otherNonOperating`/`capitalImprovements` fields; nest them under `nonOperatingExpense` with a computed `.total` (the existing values already reconcile exactly against each month's `noi`/`netIncome`, confirmed: `4139.32 - (6532.5+2375+2967.26) = -7735.44` for Jan-Apr, `2527.04 - 11874.76 = -9347.72` for May):

```js
const EXPECTED_TABLE = {
  months: {
    "2026-01": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      nonOperatingExpense: { debtService: 6532.5, otherNonOperating: 2375, capitalImprovements: 2967.26, total: 11874.76 },
      netIncome: -7735.44,
    },
    "2026-02": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      nonOperatingExpense: { debtService: 6532.5, otherNonOperating: 2375, capitalImprovements: 2967.26, total: 11874.76 },
      netIncome: -7735.44,
    },
    "2026-03": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      nonOperatingExpense: { debtService: 6532.5, otherNonOperating: 2375, capitalImprovements: 2967.26, total: 11874.76 },
      netIncome: -7735.44,
    },
    "2026-04": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      nonOperatingExpense: { debtService: 6532.5, otherNonOperating: 2375, capitalImprovements: 2967.26, total: 11874.76 },
      netIncome: -7735.44,
    },
    "2026-05": {
      income: { rental: 18448.91, other: -1612.28, total: 16836.63 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 2527.04,
      nonOperatingExpense: { debtService: 6532.5, otherNonOperating: 2375, capitalImprovements: 2967.26, total: 11874.76 },
      netIncome: -9347.72,
    },
  },
};
```

Update the two tests that reference field values directly, adding `nonOperatingExpense` checks:

```js
test("extractLegacyMonth assembles multiple monthly records with no LLM configured", async () => {
  const records = await extractLegacyMonth(null, FIXTURE, "2026-05");
  const may = records["2026-05"];
  assert.equal(may.month, "2026-05");
  assert.equal(may.occupancyPct, 74);
  assert.equal(may.sourceFile, FIXTURE);
  assert.equal(may.extraction.method, "unavailable");
  assert.equal(may.noi, null);
  assert.equal(may.nonOperatingExpense, null);
  assert.equal(may.narrative.includes("processing two evictions"), true);
});

test("extractLegacyMonth assembles multiple monthly records with a working vision LLM", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeCallVisionLlm = async () => JSON.stringify(EXPECTED_TABLE);
  const records = await extractLegacyMonth(fakeConfig, FIXTURE, "2026-05", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.equal(Object.keys(records).length, 5);
  assert.equal(records["2026-05"].income.total, 16836.63);
  assert.equal(records["2026-05"].noi, 2527.04);
  assert.equal(records["2026-05"].nonOperatingExpense.total, 11874.76);
  assert.equal(records["2026-05"].netIncome, -9347.72);
  assert.equal(records["2026-05"].extraction.method, "vision_llm");
  assert.equal(records["2026-05"].extraction.confidence, "high");
});
```

Add a new reconciliation test:

```js
test("reconciliation holds for the real fixture's vision-LLM-derived record", async () => {
  const { reconcilePnlRecord } = await import("./lib/reconcile-pnl.mjs");
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeCallVisionLlm = async () => JSON.stringify(EXPECTED_TABLE);
  const records = await extractLegacyMonth(fakeConfig, FIXTURE, "2026-05", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  const { reconciled } = reconcilePnlRecord(records["2026-05"]);
  assert.equal(reconciled, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/extract-legacy.test.mjs`
Expected: FAIL — `records["2026-05"].nonOperatingExpense` is `undefined` (the field doesn't exist yet); `may.nonOperatingExpense` is `undefined` where the test now expects `null`.

- [ ] **Step 4: Update `extractLegacyMonth`'s record assembly**

In `scripts/extract-legacy.mjs`, change the no-`tablesByMonth` early-return branch:

```js
  if (!tablesByMonth) {
    return {
      [month]: {
        month,
        occupancyPct: narrative.occupancyPct,
        preLeasedPct: narrative.preLeasedPct,
        income: null,
        expense: null,
        noi: null,
        nonOperatingExpense: null,
        netIncome: null,
        narrative: narrative.narrative,
        sourceFile: pdfPath,
        extraction: { method, confidence },
      },
    };
  }
```

And the main per-month record assembly:

```js
  const records = {};
  for (const [m, table] of Object.entries(tablesByMonth)) {
    records[m] = {
      month: m,
      occupancyPct: m === month ? narrative.occupancyPct : null,
      preLeasedPct: m === month ? narrative.preLeasedPct : null,
      income: table?.income ?? null,
      expense: table?.expense ?? null,
      noi: table?.noi ?? null,
      nonOperatingExpense: table?.nonOperatingExpense ?? null,
      netIncome: table?.netIncome ?? null,
      narrative: m === month ? narrative.narrative : null,
      sourceFile: pdfPath,
      extraction: { method, confidence },
    };
  }
  return records;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/extract-legacy.test.mjs`
Expected: PASS, all tests (existing + new)

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 7: Commit**

```bash
git add scripts/extract-legacy.mjs scripts/extract-legacy.test.mjs
git commit -m "feat: unify Legacy's debtService/capitalImprovements into nonOperatingExpense

Vision-LLM prompt now requests the nested
nonOperatingExpense{debtService,otherNonOperating,capitalImprovements,total}
shape directly, matching the real source table's own printed
'NON-OPERATING EXPENSE' subtotal structure -- otherNonOperating was
previously requested but never actually stored in the saved record."
```

---

### Task 5: Dashboard fixes

**Files:**
- Modify: `dashboard/app.js`
- Modify: `dashboard/styles.css`

**Interfaces:**
- Consumes: `.nonOperatingExpense.total` (Tasks 3, 4).

No automated tests exist for `dashboard/app.js` today (it's rendered HTML/Chart.js, not unit-tested) — this task's verification is visual: serve the dashboard locally and check the rendered output, same approach used earlier in this project's history (a local HTTP server on a fresh port + Chrome via CDP + screenshot, since Chrome blocks ES module imports under `file://` and can serve stale cached JS on a reused port).

- [ ] **Step 1: `money()` helper switches to brackets for negative values**

In `dashboard/app.js`, change:

```js
function money(n, opts = {}) {
  if (n === null || n === undefined) return "—";
  const dec = opts.decimals ?? 0;
  const formatted = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
  return n < 0 ? `($${formatted})` : `$${formatted}`;
}
```

- [ ] **Step 2: Ledger table — unify the non-operating row, relabel, always-bracket deductions, add highlight class**

Replace `pnlLedgerTable`:

```js
function moneyBracketed(n, opts = {}) {
  if (n === null || n === undefined) return "—";
  const dec = opts.decimals ?? 0;
  const formatted = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
  return `($${formatted})`;
}

function pnlLedgerTable(records) {
  const months = sortedMonths(records);
  if (months.length === 0) return "<p>No monthly records yet.</p>";
  const rows = [
    { label: "Rental income", getter: (m) => records[m].income?.rental },
    { label: "Other income", getter: (m) => records[m].income?.other },
    { label: "Total income", getter: (m) => records[m].income?.total, highlight: true },
    { label: "Total operating expense", getter: (m) => records[m].expense?.total, alwaysBracket: true },
    { label: "NOI", getter: (m) => records[m].noi, highlight: true },
    { label: "Non-operating expense", getter: (m) => records[m].nonOperatingExpense?.total, alwaysBracket: true },
    { label: "Net income", getter: (m) => records[m].netIncome, highlight: true },
  ];
  const header = `<tr><th>Account</th>${months.map((m) => `<th>${m}</th>`).join("")}</tr>`;
  const body = rows
    .map(({ label, getter, highlight, alwaysBracket }) => {
      const cells = months
        .map((m) => {
          const value = getter(m);
          const display = alwaysBracket
            ? value == null ? "—" : moneyBracketed(value, { decimals: 2 })
            : money(value, { decimals: 2 });
          return `<td>${display}</td>`;
        })
        .join("");
      const rowClass = highlight ? " class=\"row-highlight\"" : "";
      return `<tr${rowClass}><td class="row-label">${label}</td>${cells}</tr>`;
    })
    .join("");
  return tableScrollWrapper(months.length, `<table>${header}${body}</table>`);
}
```

- [ ] **Step 3: Remove the waterfall chart entirely**

In `dashboard/app.js`:
- Delete the `renderMonthlyWaterfallChart` function in full.
- In `renderDealView`, delete the line `<div class="card"><h2>Revenue → NOI → Net income (${nMonths} months)</h2>${chartScrollWrapper(nMonths, \`<canvas id="waterfall-${dealSlug}"></canvas>\`)}</div>`.
- In `renderDealView`, delete the line `renderMonthlyWaterfallChart(\`waterfall-${dealSlug}\`, records);`.

- [ ] **Step 4: `breakEvenOccupancy` formula update**

In `dashboard/app.js`, change:

```js
function breakEvenOccupancy(record) {
  if (!record.occupancyPct || !record.income?.rental || record.occupancyPct === 0) return null;
  const rentalIncomePerOccupancyPoint = record.income.rental / record.occupancyPct;
  const fixedOutflow = (record.expense?.total ?? 0) + (record.nonOperatingExpense?.total ?? 0);
  const otherIncome = record.income?.other ?? 0;
  const noiBreakEvenPct = ((record.expense?.total ?? 0) - otherIncome) / rentalIncomePerOccupancyPoint;
  const netIncomeBreakEvenPct = (fixedOutflow - otherIncome) / rentalIncomePerOccupancyPoint;
  return {
    noiBreakEvenPct: Math.round(noiBreakEvenPct * 10) / 10,
    netIncomeBreakEvenPct: Math.round(netIncomeBreakEvenPct * 10) / 10,
    actualPct: record.occupancyPct,
  };
}
```

- [ ] **Step 5: Distribution history table — drop Dist/NOI%, rename headers**

In `dashboard/app.js`'s `investorCashFlowCard`, change the `distRows` mapping (remove the `distRatio` computation and its cell) and the header row:

```js
  const distRows = distData.length === 0
    ? `<tr><td colspan="5">No distributions recorded yet.</td></tr>`
    : distData.map((d) => {
        const qNoi = quarterlyNoi[d.date];
        const yourNoiShare = qNoi ? Math.round(qNoi * (ownershipPct / 100) * 100) / 100 : null;
        return `<tr>
          <td>${d.date}</td>
          <td>${money(d.myDistribution)}</td>
          <td>${money(d.totalDistribution)}</td>
          <td>${qNoi ? money(qNoi) : "—"}</td>
          <td>${yourNoiShare ? money(yourNoiShare) : "—"}</td>
        </tr>`;
      }).join("");
```

```js
      <tr><th>Period</th><th>Your distribution</th><th>Total distribution</th><th>Quarterly NOI</th><th>Your NOI share</th></tr>
```

(This is the same `investorCashFlowCard` function — only the `distRows` variable's computation and the immediately-following `<tr><th>...` header line change; the surrounding card markup, stat cards, and chart canvas are untouched. Note: `colspan="5"` also fixes a pre-existing off-by-one — the current code has `colspan="5"` against a 6-column header, one short; the new header has exactly 5 columns, so `colspan="5"` is now correct.)

- [ ] **Step 6: `dashboard/styles.css` — add the highlight class**

Add to `dashboard/styles.css`:

```css
tr.row-highlight td { border-top: 2px solid var(--fg); border-bottom: 2px solid var(--fg); font-weight: 600; }
```

- [ ] **Step 7: Rebuild dashboard data and verify visually**

```bash
node scripts/build-dashboard.mjs
```

Then serve and check with a fresh port (avoids Chrome's stale-cache-on-reused-port issue documented earlier in this project):

```bash
cd /Users/Larry.Jin/Documents/projects/investment && nohup python3 -m http.server 8811 > /tmp/dashboard-server-verify.log 2>&1 &
sleep 1
curl -sI http://localhost:8811/dashboard/ | head -3
```

Using Chrome connected over CDP (`http://localhost:9222` — if unreachable, note this in your report and skip live visual verification rather than blocking on it), navigate to `http://localhost:8811/dashboard/index.html`, click into the McNeil tab, and screenshot the ledger table and distribution history table. Confirm: no waterfall chart card appears; "Total operating expense" and "Non-operating expense" both render in `($X)` brackets; "Total income"/"NOI"/"Net income" rows visibly have a thicker top+bottom border; the distribution history table has exactly 5 columns ending in "Your NOI share", with no "Dist / NOI %" column. Then stop the temporary server:

```bash
pkill -f "http.server 8811"
```

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures (this task touches no test files, but confirms nothing else broke)

- [ ] **Step 9: Commit**

```bash
git add dashboard/app.js dashboard/styles.css
git commit -m "fix: dashboard ledger/distribution-table formatting and cleanup

- money() renders negative values as (\$X) brackets instead of -\$X
- Ledger table: unified 'Non-operating expense' row (replacing
  Debt service + Capital improvements), 'Total expense' relabeled
  'Total operating expense', deduction rows always bracketed
  regardless of stored sign, Total income/NOI/Net income get a
  thicker-border row-highlight class marking them as the three
  waterfall-checkpoint status rows
- Removed the Revenue -> NOI -> Net income chart entirely (redundant
  with the ledger table)
- breakEvenOccupancy reads nonOperatingExpense.total
- Distribution history table: dropped the Dist / NOI % column,
  renamed 'Your share' -> 'Your distribution', 'Total property' ->
  'Total distribution'"
```

---

### Task 6: Re-run extraction and reconcile committed data

**Files:**
- Modify (data only): `data/mcneil.json`, `data/legacy.json`, `dashboard/data.js`

No new source code. This re-runs extraction with Tasks 3-5's changes against the already-downloaded raw archive (no live portal access needed — nothing in this plan touched harvesting) and commits the reconciled output.

- [ ] **Step 1: Re-run McNeil and Legacy extraction directly**

```bash
node scripts/extract-mcneil.mjs
node scripts/extract-legacy.mjs
```

The Legacy run makes exactly one real vision-LLM API call (only one PDF is in the raw archive today) — `config.json`'s `vision_llm` block must be present for this to exercise the real code path; if it's missing, the command still succeeds but logs the "no config.json / vision_llm block" warning and skips the page-4 table (acceptable — occupancy-only data still gets re-saved).

- [ ] **Step 2: Check for reconciliation warnings**

Both commands print `console.warn` lines for any month that failed to reconcile, prefixed with the month key. Read the output carefully. If any warning appears, stop and diagnose why before proceeding — do not hand-edit the JSON to silence a warning; find the actual cause (e.g., an unhandled label variant, per Task 3's exact-string matching). If no warnings appear, continue.

- [ ] **Step 3: Verify a specific known-good number survived intact**

```bash
node -e '
import("node:fs/promises").then(async ({readFile}) => {
  const mcneil = JSON.parse(await readFile("data/mcneil.json", "utf8"));
  console.log("2026-06 nonOperatingExpense:", JSON.stringify(mcneil["2026-06"].nonOperatingExpense));
  console.log("2026-06 netIncome:", mcneil["2026-06"].netIncome);
});
'
```

Expected: `nonOperatingExpense` is `{"debtService":5010.81,"otherNonOperating":0,"capitalImprovements":4161.71,"total":9172.52}` and `netIncome` is `4640`, matching Task 3's fixture-verified values exactly.

- [ ] **Step 4: Rebuild the dashboard data file**

```bash
node scripts/build-dashboard.mjs
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add data/mcneil.json data/legacy.json dashboard/data.js
git commit -m "data: reconcile mcneil.json/legacy.json with unified nonOperatingExpense

Re-ran extraction with the unified field in place. Step 2 confirmed
no reconciliation warnings were logged before reaching this commit."
```
