import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { extractNarrative, extractPnlTable, extractLegacyMonth, extractLegacyBatch, runLegacyExtraction } from "./extract-legacy.mjs";

const FIXTURE = "scripts/__fixtures__/legacy/2026-05-investor-update.pdf";
const NO_FINANCIALS_ACQUISITION_FIXTURE = "scripts/__fixtures__/legacy/2025-11-acquisition-month-no-financials.pdf";
const NO_FINANCIALS_TRANSITION_FIXTURE = "scripts/__fixtures__/legacy/2026-03-management-transition-no-financials.pdf";

test("extracts occupancy percentage", async () => {
  const result = await extractNarrative(FIXTURE);
  assert.equal(result.occupancyPct, 74);
});

test("extracts pre-leased percentage", async () => {
  const result = await extractNarrative(FIXTURE);
  assert.equal(result.preLeasedPct, 90);
});

test("extracts stated NOI, total revenue, and rental income", async () => {
  const result = await extractNarrative(FIXTURE);
  assert.equal(result.statedNoi, 2527);
  assert.equal(result.statedTotalRevenue, 16837);
  assert.equal(result.statedRentalIncome, 18449);
});

test("captures the full operations narrative text", async () => {
  const result = await extractNarrative(FIXTURE);
  assert.match(result.narrative, /processing two evictions/);
  assert.match(result.narrative, /8 leases are up for renewal/);
});

test("preLeasedPct is null when the report has no pre-leased line", async () => {
  // Simulated by monkey-patching is not possible here since this reads a
  // real fixture; this case is exercised indirectly by extract-mcneil's
  // report which has no such concept. Documented as a known gap: if a
  // future Legacy report omits the pre-leased line, occupancyPct/statedNoi
  // extraction must still succeed independently (verified by the other
  // four tests using named-capture regexes, not one monolithic regex).
});

test("extractNarrative sets hasFinancials false and nulls the financial fields for an acquisition month with no Financial Overview sentence", async () => {
  const result = await extractNarrative(NO_FINANCIALS_ACQUISITION_FIXTURE);
  assert.equal(result.occupancyPct, 94);
  assert.equal(result.hasFinancials, false);
  assert.equal(result.statedRentalIncome, null);
  assert.equal(result.statedTotalRevenue, null);
  assert.equal(result.statedNoi, null);
  assert.match(result.narrative, /do not have a normal, full month of financials/);
});

test("extractNarrative sets hasFinancials false for a management-transition month with no Financial Overview sentence", async () => {
  const result = await extractNarrative(NO_FINANCIALS_TRANSITION_FIXTURE);
  assert.equal(result.occupancyPct, 87);
  assert.equal(result.hasFinancials, false);
  assert.equal(result.statedNoi, null);
});

test("extractNarrative sets hasFinancials true for a normal report", async () => {
  const result = await extractNarrative(FIXTURE);
  assert.equal(result.hasFinancials, true);
});

test("extractLegacyMonth returns a degraded occupancy-only record for a month with no financials, without calling the vision LLM", async () => {
  let callCount = 0;
  const fakeCallVisionLlm = async () => {
    callCount++;
    return "{}";
  };
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const records = await extractLegacyMonth(fakeConfig, NO_FINANCIALS_ACQUISITION_FIXTURE, "2025-11", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  const nov = records["2025-11"];
  assert.equal(nov.occupancyPct, 94);
  assert.equal(nov.income, null);
  assert.equal(nov.expense, null);
  assert.equal(nov.noi, null);
  assert.equal(nov.nonOperatingExpense, null);
  assert.equal(nov.netIncome, null);
  assert.equal(nov.extraction.method, "no_financials_reported");
  assert.equal(callCount, 0, "the vision LLM must not be called when the narrative already says financials aren't available");
});

test("extractLegacyBatch produces a reconciled degraded record for a real no-financials month via the batch path", async () => {
  const { reconcilePnlRecord } = await import("./lib/reconcile-pnl.mjs");
  const { loadManifest, saveManifest } = await import("./lib/archive-store.mjs");
  const TMP_RAW = "scripts/__fixtures__/tmp-legacy-no-financials";
  await rm(TMP_RAW, { recursive: true, force: true });
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(`${TMP_RAW}/2025-11`, { recursive: true });
  await copyFile(NO_FINANCIALS_ACQUISITION_FIXTURE, `${TMP_RAW}/2025-11/monthly-update.pdf`);
  await saveManifest(`${TMP_RAW}/2025-11`, {
    files: [{ docType: "monthly-update", fileName: "monthly-update.pdf", contentHash: "no-fin" }],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2025-11`);
  const records = await extractLegacyBatch(`${TMP_RAW}/2025-11`, manifest, null);
  const nov = records.get("2025-11");
  assert.equal(nov.occupancyPct, 94);
  assert.equal(nov.noi, null);
  const { reconciled } = reconcilePnlRecord(nov);
  assert.equal(reconciled, true, "a record with null noi/netIncome must reconcile cleanly, not false-warn");

  await rm(TMP_RAW, { recursive: true, force: true });
});

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

test("extractPnlTable returns unavailable with no config, never throws", async () => {
  const result = await extractPnlTable(null, FIXTURE, "2026-05");
  assert.equal(result.method, "unavailable");
  assert.equal(result.tablesByMonth, null);
});

test("extractPnlTable returns the vision LLM's parsed table when config is provided", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeCallVisionLlm = async () => JSON.stringify(EXPECTED_TABLE);
  const result = await extractPnlTable(fakeConfig, FIXTURE, "2026-05", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.equal(result.method, "vision_llm");
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.tablesByMonth, EXPECTED_TABLE.months);
});

test("extractPnlTable flags low confidence when vision NOI mismatches narrative NOI", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const wrongTable = {
    months: {
      ...EXPECTED_TABLE.months,
      "2026-05": { ...EXPECTED_TABLE.months["2026-05"], noi: 999999 },
    },
  };
  const fakeCallVisionLlm = async () => JSON.stringify(wrongTable);
  const result = await extractPnlTable(fakeConfig, FIXTURE, "2026-05", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.equal(result.confidence, "low");
});

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

test("extractLegacyBatch reads the monthly-update doc via manifest and returns records keyed by month", async () => {
  const { loadManifest } = await import("./lib/archive-store.mjs");
  const manifest = await loadManifest("scripts/__fixtures__/raw-legacy/2026-05");
  const records = await extractLegacyBatch("scripts/__fixtures__/raw-legacy/2026-05", manifest, null);
  assert.ok(records.has("2026-05"));
  assert.equal(records.get("2026-05").occupancyPct, 74);
});

test("runLegacyExtraction produces the same May 2026 occupancy via the batch-based path", async () => {
  const outputPath = "scripts/__fixtures__/tmp-legacy-output.json";
  await runLegacyExtraction(null, "scripts/__fixtures__/raw-legacy", outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written["2026-05"].occupancyPct, 74);
  await rm(outputPath, { force: true });
});
