# Non-Operating Expense Unification & Dashboard Fixes — Design

## Evidence

Legacy's real source table (page 4 of its monthly investor update, `scripts/__fixtures__/legacy/2026-05-investor-update.pdf`) has this literal structure:

```
INCOME
  Rental Income / Other Income → INCOME (total)
EXPENSE
  Administration Expense / Marketing / ... → EXPENSE (total)
NET OPERATING INCOME
NON-OPERATING EXPENSE
  Debt Service
  Other Non-Operating Expenses
  Capital Improvements
  → NON-OPERATING EXPENSE (total)
NET INCOME
```

McNeil's reports have the same shape (`TOTAL EXPENSE` → `NET OPERATING INCOME` → `TOTAL NON-OPERATING EXPENSE`, sometimes itemized into `Total Debt Service`/etc. beneath it, sometimes only the aggregate line) → `NET INCOME`. The two properties' source documents already agree on this structure. Today's code only ever captured `debtService` and `capitalImprovements` as two independent top-level fields, populated inconsistently (McNeil's older/aggregate-only report formats leave both at 0; Legacy's vision-LLM prompt asks for three separate fields with no combined total). This is the direct cause of the zero-filled non-operating figures the user flagged, and of the two properties never being comparable on this line.

The source document also already uses parentheses for negative values (e.g. `(1,612.28)`, `(12,705.66)`) — precedent for the bracket-formatting request below.

## 1. Data model: unified `nonOperatingExpense`

Both `scripts/extract-mcneil.mjs` and `scripts/extract-legacy.mjs` produce:

```js
nonOperatingExpense: {
  debtService: number,       // 0 if not itemized in the source for this month
  otherNonOperating: number,
  capitalImprovements: number,
  total: number,             // always populated — the one field every consumer reads
}
```

This replaces the current top-level `debtService`/`capitalImprovements` fields entirely (removed, not kept alongside). `.total` is sourced from the aggregate "(TOTAL) NON-OPERATING EXPENSE" line whenever it's present (nearly always); the three sub-fields are populated only in report formats that itemize them, left at 0 otherwise — mirroring exactly how `expense{...,total}` already works for operating expenses.

**McNeil (`extractMcneilPnl`):** add label-matching for `TOTAL NON-OPERATING EXPENSE` → `nonOperatingExpense.total`, and (for the report formats that itemize it) `Total Debt Service`/`Total Capital Improvements`/other non-operating sub-lines → the matching sub-field. Remove the current separate `debtService`/`capitalImprovements` assignment logic.

**Legacy (`extractPnlTable`'s vision-LLM prompt):** change the requested JSON shape from three flat fields to the nested `nonOperatingExpense: {debtService, otherNonOperating, capitalImprovements, total}` object, matching the real printed table exactly (it already has a `NON-OPERATING EXPENSE` total line the current prompt never asked for).

## 2. Reconciliation validation

New `scripts/lib/reconcile-pnl.mjs`:

```js
export function reconcilePnlRecord(record) {
  const notes = [];
  const TOLERANCE = 1; // matches the existing NOI_CROSS_CHECK_TOLERANCE precedent

  const expectedNoi = (record.income?.total ?? 0) - (record.expense?.total ?? 0);
  if (record.noi != null && Math.abs(expectedNoi - record.noi) > TOLERANCE) {
    notes.push(`NOI mismatch: income.total (${record.income?.total}) - expense.total (${record.expense?.total}) = ${expectedNoi}, but noi is ${record.noi}`);
  }

  const expectedNetIncome = (record.noi ?? 0) - (record.nonOperatingExpense?.total ?? 0);
  if (record.netIncome != null && Math.abs(expectedNetIncome - record.netIncome) > TOLERANCE) {
    notes.push(`Net income mismatch: noi (${record.noi}) - nonOperatingExpense.total (${record.nonOperatingExpense?.total}) = ${expectedNetIncome}, but netIncome is ${record.netIncome}`);
  }

  return { reconciled: notes.length === 0, notes };
}
```

Wired into `scripts/lib/run-extraction.mjs`'s `runGenericExtraction`, after `foldMonths` merges all batches and before `saveRecords` — the one place both deals' final, as-persisted-to-JSON records pass through. For each month: run `reconcilePnlRecord`, `console.warn` every note prefixed with the month key, and stamp the record with `reconciled: false` when notes exist (omit the field — don't write `reconciled: true` — when clean, to avoid bloating already-reconciled historical records). `npm run refresh` keeps processing every other month; nothing throws.

## 3. Ledger table (`dashboard/app.js`)

- Row list changes from `[Rental income, Other income, Total income, Total expense, NOI, Debt service, Capital improvements, Net income]` to `[Rental income, Other income, Total income, Total operating expense, NOI, Non-operating expense, Net income]` — one row replaces two, and "Total expense" is relabeled "Total operating expense" (display label only; the underlying field stays `expense.total`, no JSON schema rename) to read unambiguously against the new "Non-operating expense" row beside it.
- The shared `money()` helper switches from `"-$X"` to `"($X)"` for negative values, dashboard-wide (stat cards, distribution history, ledger cells — everywhere it's already used).
- "Total operating expense" and "Non-operating expense" rows always render bracketed regardless of stored sign (`(${money(Math.abs(value))})`-style), since they're always a subtraction in the running total, not because their value happens to be negative.
- "Total income", "NOI", and "Net income" rows get a new CSS class (e.g. `.row-highlight`) giving thicker top and bottom borders than the table's regular thin gray row lines.

## 4. Waterfall chart (`renderMonthlyWaterfallChart`)

The "Debt service" and "Capital imp." bar series merge into one "Non-operating expense" series reading `nonOperatingExpense.total` — matching how "Expenses" is already a single total bar (its own itemization lives separately in the "Expense breakdown" chart). No new breakdown chart is added for non-operating expense; that's out of scope unless requested later.

## 5. `breakEvenOccupancy`

`fixedOutflow` changes from `expense.total + debtService + capitalImprovements` to `expense.total + nonOperatingExpense.total`.

## 6. Distribution history table (`investorCashFlowCard`)

Drop the "Dist / NOI %" column and its computation (`distRatio`) entirely. Rename headers: "Your share" → "Your distribution", "Total property" → "Total distribution". Resulting columns: `Period, Your distribution, Total distribution, Quarterly NOI, Your NOI share`.

## Non-Goals

- No new non-operating-expense breakdown chart.
- No change to the underlying `expense` field's itemization behavior (per-deal category names stay whatever each source document prints).
- No retroactive re-derivation of historical `debtService`/`capitalImprovements` values beyond what `npm run refresh` naturally recomputes from the raw archive.

## Testing

- `scripts/lib/reconcile-pnl.test.mjs` (new): reconciled and mismatched cases, using constructed records (this is pure arithmetic validation, not PDF parsing — synthetic inputs are appropriate here, unlike the extraction layer itself).
- `scripts/extract-mcneil.test.mjs`: update existing assertions that reference `debtService`/`capitalImprovements` to the new `nonOperatingExpense` shape; add a case verifying `nonOperatingExpense.total` populates from the aggregate line and sub-fields populate only when itemized (using the already-committed real fixtures).
- `scripts/extract-legacy.mjs`: update the vision-LLM prompt and result-shaping logic; existing tests that mock `callVisionLlmImpl` update their fixture response shape to the new nested object.
- `scripts/lib/run-extraction.test.mjs` (or wherever `runGenericExtraction` is tested): verify a deliberately-mismatched record gets `reconciled: false` and a console warning, while other months in the same batch still get saved.
- No new dashboard/app.js automated tests exist today (it's rendered HTML/Chart.js, not unit-tested) — verification is visual, via the same Playwright-over-CDP + local-server approach used earlier this session.
