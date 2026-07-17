import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { extractMcneilPnl, extractMcneilDistributions, runMcneilExtraction } from "./extract-mcneil.mjs";

const FIXTURE = "scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf";

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

test("runMcneilExtraction scans a raw dir, merges PDF + rent roll, writes JSON", async () => {
  const outputPath = "scripts/__fixtures__/tmp-mcneil-output.json";
  const result = await runMcneilExtraction("scripts/__fixtures__/raw-mcneil", outputPath);
  assert.ok(result.monthsProcessed.includes("2026-06"));
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written["2026-06"].netIncome, 4640.0);
  assert.ok("occupancyPct" in written["2026-06"], "rent roll occupancy should be merged into the June record");
  await rm(outputPath);
});
