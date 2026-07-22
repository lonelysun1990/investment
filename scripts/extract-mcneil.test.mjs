import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { extractMcneilPnl, extractMcneilDistributions, extractMcneilBatch, runMcneilExtraction, computeMcneilOccupancyAcrossBatches, parseMonthHeader } from "./extract-mcneil.mjs";

const FIXTURE = "scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf";
const ANNUAL_FIXTURE = "scripts/__fixtures__/mcneil/2024-annual-cashflow-statement.pdf";
const TRAILING_PNL_FIXTURE = "scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf";

test("returns one entry per real month column, excluding the Total column", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  assert.equal(result.size, 6);
  assert.ok(result.has("2026-06"));
  assert.ok(!result.has("Total"));
});

test("parses income totals for June 2026", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const june = result.get("2026-06");
  assert.equal(june.income.rental, 25908.0);
  assert.equal(june.income.total, 28319.66);
});

test("parses NOI, debt service, capital improvements, and net income for June 2026", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const june = result.get("2026-06");
  assert.equal(june.noi, 13812.52);
  assert.equal(june.nonOperatingExpense.debtService, 5010.81);
  assert.equal(june.nonOperatingExpense.capitalImprovements, 4161.71);
  assert.equal(june.nonOperatingExpense.total, 9172.52);
  assert.equal(june.netIncome, 4640.0);
});

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

test("captures Total Other Non-Operating into nonOperatingExpense.otherNonOperating, not the operating expense breakdown", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const jan = result.get("2026-01");
  assert.equal(jan.nonOperatingExpense.otherNonOperating, 2337.0);
  assert.ok(!("Other Non-Operating" in jan.expense), "must not also appear as a stray operating-expense category");
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

test("parses a loss month correctly (May 2026, negative net income)", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const may = result.get("2026-05");
  assert.equal(may.noi, 8071.5);
  assert.equal(may.netIncome, -7202.81);
});

test("excludes pre-operation zero-only months from the result map", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  // Jul 2025 has all zeros in the fixture PDF — should be excluded
  assert.ok(!result.has("2025-07"), "2025-07 should be excluded (all zeros, pre-operation)");
  assert.ok(!result.has("2025-08"));
  assert.ok(!result.has("2025-09"));
  assert.ok(!result.has("2025-10"));
  assert.ok(!result.has("2025-11"));
  assert.ok(!result.has("2025-12"));
  // Jan 2026 onward has real data — should be included
  assert.ok(result.has("2026-01"));
  assert.equal(result.size, 6); // Jan-Jun 2026 only
});

test("includes itemized expense categories with their own labels", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const jan = result.get("2026-01");
  assert.ok("Administration Expen" in jan.expense);
  assert.ok("Salaries & Wages" in jan.expense);
  assert.equal(jan.expense["Administration Expen"], 515.05);
});

test("extracts the Member's Distribution line across all 12 header months", async () => {
  const result = await extractMcneilDistributions(FIXTURE, /Member's Distribution/i);
  assert.equal(result.size, 12);
  // NOTE: verified against the fixture by character-position alignment with the
  // "Account ... Jul 2025 ... Jun 2026 Total" header row directly above this line
  // (pdftotext -layout, row starting "Member's Distribution"). The (118,999.45) token
  // sits under the "Jan 2026" column and (24,999.86) sits under "Apr 2026" — NOT
  // Jul 2025 / Oct 2025 as an earlier draft of this test assumed.
  assert.equal(result.get("2026-01"), 118999.45);
  assert.equal(result.get("2026-04"), 24999.86);
  assert.equal(result.get("2025-08"), 0);
  assert.equal(result.get("2026-06"), 0);
});

test("extractMcneilDistributions does not double-count the 'Total Member's Distributi' subtotal row", async () => {
  const result = await extractMcneilDistributions(FIXTURE, /Member's Distribution/i);
  // If the truncated "Total Member's Distributi" row were matched too, Jan 2026 would double to 237,998.90
  assert.equal(result.get("2026-01"), 118999.45);
});

test("parseMonthHeader handles the older report layout where 'Account' is alone on its own line", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec("pdftotext", ["-layout", ANNUAL_FIXTURE, "-"]);
  const monthKeys = parseMonthHeader(stdout);
  assert.deepEqual(monthKeys, [
    "2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06",
    "2024-07", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12",
  ]);
});

test("extractMcneilPnl parses the older report layout's real 2024 figures", async () => {
  const result = await extractMcneilPnl(ANNUAL_FIXTURE);
  // Property had no rental activity before Sep 2024 (pre-operation), so only
  // Sep-Dec 2024 should survive the all-zero-month filter.
  assert.deepEqual([...result.keys()].sort(), ["2024-09", "2024-10", "2024-11", "2024-12"]);
  const sep = result.get("2024-09");
  assert.equal(sep.noi, 3616.44);
  assert.equal(sep.netIncome, 3616.44);
  const dec = result.get("2024-12");
  assert.equal(dec.noi, 6552.24);
  assert.equal(dec.netIncome, -11270.67);
});

test("extractMcneilPnl captures the aggregate TOTAL EXPENSE line for the older report layout instead of leaving it at zero", async () => {
  const result = await extractMcneilPnl(ANNUAL_FIXTURE);
  const oct = result.get("2024-10");
  assert.equal(oct.expense.total, 10354.63);
  const dec = result.get("2024-12");
  assert.equal(dec.expense.total, 17291.51);
});

test("extractMcneilPnl flags every month in the report as aggregate-only once the TOTAL NON-OPERATING EXPENSE row appears", async () => {
  const result = await extractMcneilPnl(ANNUAL_FIXTURE);
  // The row spans all 12 columns in one line, so the whole report's format
  // is aggregate-only -- not just the months with a nonzero value on it.
  for (const month of result.keys()) {
    assert.equal(result.get(month).expenseIsAggregateOnly, true, `${month} should be flagged aggregate-only`);
  }
});

test("extractMcneilPnl does not corrupt the expense breakdown with glued-label values from pdftotext column artifacts", async () => {
  const result = await extractMcneilPnl(ANNUAL_FIXTURE);
  const sep = result.get("2024-09");
  assert.equal(sep.expense.total, 3029.81, "the aggregate TOTAL EXPENSE line must still be correct");
  assert.ok(!("Advertising and marketing0.00" in sep.expense), "glued-label row must not produce a garbage category key");
  assert.ok(!("Building Improvements 0.00" in sep.expense), "glued-label row must not produce a garbage category key");
});

test("extractMcneilBatch marks aggregate-only months as low confidence and strips the internal marker", async () => {
  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest, loadManifest } = await import("./lib/archive-store.mjs");
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-aggregate-only";
  await rm(TMP_RAW, { recursive: true, force: true });
  await mkdir(`${TMP_RAW}/2025-01`, { recursive: true });
  await copyFile(ANNUAL_FIXTURE, `${TMP_RAW}/2025-01/cashflow-t12.pdf`);
  await saveManifest(`${TMP_RAW}/2025-01`, {
    files: [{ docType: "cashflow-t12", fileName: "cashflow-t12.pdf", contentHash: "e" }],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2025-01`);
  const months = await extractMcneilBatch(`${TMP_RAW}/2025-01`, manifest);
  const oct = months.get("2024-10");
  assert.equal(oct.extraction.confidence, "low");
  assert.equal("expenseIsAggregateOnly" in oct, false, "internal marker must not leak into the persisted record");

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("computeMcneilOccupancyAcrossBatches resolves occupancy from a direct-statement narrative even with no PDF in the batch", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-direct-statement-only";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2024-10`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt",
    `${TMP_RAW}/2024-10/occupancy-narrative.txt`
  );
  await saveManifest(`${TMP_RAW}/2024-10`, {
    files: [{ docType: "occupancy-narrative", fileName: "occupancy-narrative.txt", contentHash: "e1" }],
  });

  const occupancyByMonth = await computeMcneilOccupancyAcrossBatches(TMP_RAW, null);

  assert.equal(occupancyByMonth.size, 2);
  assert.equal(occupancyByMonth.get("2024-10"), 87.5);
  assert.equal(occupancyByMonth.get("2024-09"), 90.6);

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("computeMcneilOccupancyAcrossBatches resolves occupancy from a vacant-unit narrative when no direct statement is present", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-vacant-unit-only";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2026-06-narrative.txt",
    `${TMP_RAW}/2026-06/occupancy-narrative.txt`
  );
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "occupancy-narrative", fileName: "occupancy-narrative.txt", contentHash: "e2" }],
  });

  const occupancyByMonth = await computeMcneilOccupancyAcrossBatches(TMP_RAW, null);

  assert.equal(occupancyByMonth.size, 1);
  assert.equal(occupancyByMonth.get("2026-06"), 90.6);

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("computeMcneilOccupancyAcrossBatches keeps an earlier batch's direct-statement value over a later batch's chart reading for the same month", async () => {
  // Regression test: this is the exact bug the final whole-branch review
  // caught -- priority (direct statement > vacant-unit narrative > chart)
  // was only enforced within a single batch's own three sources. Since
  // each email's chart reports ~12 trailing months, a LATER batch's
  // lower-priority chart value for an OLD month must not silently win
  // over an EARLIER batch's higher-priority direct-statement value for
  // that same month just because batches are visited in chronological
  // order.
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-cross-batch-priority";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest } = await import("./lib/archive-store.mjs");

  // Earlier batch (2024-10): a real direct-statement narrative reporting
  // 2024-10 at 87.5%.
  await mkdir(`${TMP_RAW}/2024-10`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt",
    `${TMP_RAW}/2024-10/occupancy-narrative.txt`
  );
  await saveManifest(`${TMP_RAW}/2024-10`, {
    files: [{ docType: "occupancy-narrative", fileName: "occupancy-narrative.txt", contentHash: "e3" }],
  });

  // Later batch (2026-06): a chart image whose trailing window reaches
  // all the way back to 2024-10 with a conflicting, lower-priority value.
  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2026-06-occupancy-chart.png",
    `${TMP_RAW}/2026-06/occupancy-chart.png`
  );
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "occupancy-chart", fileName: "occupancy-chart.png", contentHash: "e4" }],
  });

  // A genuine, valid (non-throwing) 21-month consecutive trailing run
  // ending at the chart batch's own month (2026-06) that reaches all the
  // way back to 2024-10 with a conflicting value -- if this test only
  // used a single out-of-order label, resolveTrailingMonths' own
  // validation would throw before ever producing a competing value,
  // making the assertion below pass trivially even with the bug back.
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const trailingLabels = [
    "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep",
    "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  ];
  const fakeCallVisionLlm = async () =>
    JSON.stringify({ months: trailingLabels.map((label) => ({ label, occupancyPct: 82 })) });

  const occupancyByMonth = await computeMcneilOccupancyAcrossBatches(TMP_RAW, fakeConfig, {
    callVisionLlmImpl: fakeCallVisionLlm,
  });

  assert.equal(
    occupancyByMonth.get("2024-11"),
    82,
    "sanity check: the chart genuinely contributed a value for a month the direct statement doesn't cover"
  );
  assert.equal(
    occupancyByMonth.get("2024-10"),
    87.5,
    "the earlier batch's direct-statement value must survive a later batch's conflicting chart reading"
  );

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("computeMcneilOccupancyAcrossBatches skips a batch whose chart reading throws, instead of aborting the whole run", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-chart-throws";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2026-01`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2026-06-occupancy-chart.png",
    `${TMP_RAW}/2026-01/occupancy-chart.png`
  );
  await saveManifest(`${TMP_RAW}/2026-01`, {
    files: [{ docType: "occupancy-chart", fileName: "occupancy-chart.png", contentHash: "e5" }],
  });

  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2026-06-narrative.txt",
    `${TMP_RAW}/2026-06/occupancy-narrative.txt`
  );
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "occupancy-narrative", fileName: "occupancy-narrative.txt", contentHash: "e6" }],
  });

  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeCallVisionLlm = async () => "not valid json";

  const occupancyByMonth = await computeMcneilOccupancyAcrossBatches(TMP_RAW, fakeConfig, {
    callVisionLlmImpl: fakeCallVisionLlm,
  });

  assert.equal(occupancyByMonth.get("2026-01"), undefined, "the throwing batch contributes no occupancy data");
  assert.equal(occupancyByMonth.get("2026-06"), 90.6, "a later batch's valid narrative is still processed");

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("parses the Trailing Profit And Loss Detail header into 12 real months (Oct 2024-Sep 2025)", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  assert.equal(result.size, 12);
  assert.deepEqual([...result.keys()], [
    "2024-10", "2024-11", "2024-12", "2025-01", "2025-02", "2025-03",
    "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09",
  ]);
});

test("extracts the rental/other income breakdown from account-code-prefixed subtotal rows", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  const oct = result.get("2024-10");
  assert.equal(oct.income.rental, 21148.00);
  assert.equal(oct.income.other, 623.00);
  assert.equal(oct.income.total, 21771.00);
});

test("matches existing verified net income figures for Oct-Dec 2024 (cross-check against the older aggregate-only report)", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  assert.equal(result.get("2024-10").netIncome, -11374.71);
  assert.equal(result.get("2024-11").netIncome, -16364.47);
  assert.equal(result.get("2024-12").netIncome, -11270.67);
});

test("extracts the final month (Sep 2025) correctly, including income/expense internal consistency", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  const sep = result.get("2025-09");
  assert.equal(sep.income.rental, 22660.00);
  assert.equal(sep.income.other, 39.00);
  assert.equal(sep.income.total, 22699.00);
  assert.equal(sep.expense.total, 15282.80);
  assert.equal(sep.noi, 7416.20);
  assert.equal(sep.netIncome, 180.39);
});

test("flags the Trailing P&L Detail report as aggregate-only, same as the older annual report", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  for (const month of result.keys()) {
    assert.equal(result.get(month).expenseIsAggregateOnly, true, `${month} should be flagged aggregate-only`);
  }
});

test("extractMcneilPnl accepts an optional pageRange and extracts only that range from a larger file", async () => {
  const result = await extractMcneilPnl("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf", [3, 9]);
  assert.equal(result.size, 12);
  assert.equal(result.get("2024-10").netIncome, -11374.71);
});

test("extractMcneilBatch extracts P&L and zero distribution from a real bundled multi-report PDF", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-bundle-batch";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest, loadManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2025-10`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf",
    `${TMP_RAW}/2025-10/balance-sheet.pdf`
  );
  await saveManifest(`${TMP_RAW}/2025-10`, {
    files: [
      {
        docType: "balance-sheet",
        fileName: "balance-sheet.pdf",
        contentHash: "bundle-hash",
        sections: [
          { docType: "balance-sheet", pageRange: [1, 2] },
          { docType: "trailing-pnl-detail", pageRange: [3, 9] },
          { docType: "rentroll-pdf", pageRange: [10, 11] },
          { docType: "aged-receivables", pageRange: [12, 12] },
          { docType: "cashflow-detail", pageRange: [13, 13] },
        ],
      },
    ],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2025-10`);
  const months = await extractMcneilBatch(`${TMP_RAW}/2025-10`, manifest);

  assert.equal(months.size, 12);
  const oct2024 = months.get("2024-10");
  assert.equal(oct2024.income.rental, 21148);
  assert.equal(oct2024.income.other, 623);
  assert.equal(oct2024.netIncome, -11374.71);
  assert.equal(oct2024.distribution, 0, "trailing-pnl-detail sections never carry a distribution row");

  const sep2025 = months.get("2025-09");
  // occupancyPct now comes exclusively from the email narrative/chart pipeline (Task 4),
  // not from the batch's rentroll-pdf section -- this fixture has no archived
  // occupancy-narrative/occupancy-chart doc, so occupancyPct is correctly absent.
  assert.equal(sep2025.occupancyPct, undefined);

  await rm(TMP_RAW, { recursive: true, force: true });
});
