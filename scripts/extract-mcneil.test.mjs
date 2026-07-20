import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { extractMcneilPnl, extractMcneilDistributions, extractMcneilBatch, runMcneilExtraction, parseMonthHeader } from "./extract-mcneil.mjs";

const FIXTURE = "scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf";
const ANNUAL_FIXTURE = "scripts/__fixtures__/mcneil/2024-annual-cashflow-statement.pdf";

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
  assert.equal(june.debtService, 5010.81);
  assert.equal(june.capitalImprovements, 4161.71);
  assert.equal(june.netIncome, 4640.0);
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

test("extractMcneilBatch attaches occupancy only to the month the rent roll's as-of date falls in", async () => {
  const { loadManifest } = await import("./lib/archive-store.mjs");
  const manifest = await loadManifest("scripts/__fixtures__/raw-mcneil/2026-06");
  const months = await extractMcneilBatch("scripts/__fixtures__/raw-mcneil/2026-06", manifest);
  assert.equal(months.get("2026-06").occupancyPct, 84.4);
  assert.equal(months.get("2026-05").occupancyPct, undefined);
});

test("extractMcneilBatch emits an occupancy-only record when the batch has a rentroll but no cashflow-t12 PDF", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-rentroll-only";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest, loadManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile("scripts/__fixtures__/mcneil/2026-06-rent-roll.xlsx", `${TMP_RAW}/2026-06/rentroll.xlsx`);
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "rentroll", fileName: "rentroll.xlsx", contentHash: "d" }],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2026-06`);
  const months = await extractMcneilBatch(`${TMP_RAW}/2026-06`, manifest);

  assert.equal(months.size, 1);
  const june = months.get("2026-06");
  assert.ok(june, "expected a 2026-06 record from the rentroll-only batch");
  assert.equal(june.occupancyPct, 84.4);
  assert.ok(june.rentRoll, "expected the record to include the full rentRoll object");

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("runMcneilExtraction folds batches so an earlier batch's occupancy survives a later batch that lacks a rent roll", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-fold-raw";
  const outputPath = "scripts/__fixtures__/tmp-mcneil-fold-output.json";
  await rm(TMP_RAW, { recursive: true, force: true });
  await rm(outputPath, { force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2026-05`, { recursive: true });
  await copyFile("scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf", `${TMP_RAW}/2026-05/cashflow-t12.pdf`);
  await copyFile("scripts/__fixtures__/mcneil/2026-06-rent-roll.xlsx", `${TMP_RAW}/2026-05/rentroll.xlsx`);
  await saveManifest(`${TMP_RAW}/2026-05`, {
    files: [
      { docType: "cashflow-t12", fileName: "cashflow-t12.pdf", contentHash: "a" },
      { docType: "rentroll", fileName: "rentroll.xlsx", contentHash: "b" },
    ],
  });

  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile("scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf", `${TMP_RAW}/2026-06/cashflow-t12.pdf`);
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "cashflow-t12", fileName: "cashflow-t12.pdf", contentHash: "c" }],
  });

  await runMcneilExtraction(TMP_RAW, outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written["2026-06"].occupancyPct, 84.4, "occupancy from the 2026-05 batch's rent roll should survive into 2026-06");

  await rm(TMP_RAW, { recursive: true, force: true });
  await rm(outputPath, { force: true });
});
