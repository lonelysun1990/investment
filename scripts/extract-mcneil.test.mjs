import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMcneilPnl } from "./extract-mcneil.mjs";

const FIXTURE = "scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf";

test("returns one entry per real month column, excluding the Total column", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  assert.equal(result.size, 12);
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

test("correctly represents pre-acquisition months as zero, not missing", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const jul2025 = result.get("2025-07");
  assert.ok(jul2025, "2025-07 column must still be present in the map");
  assert.equal(jul2025.income.total, 0);
  assert.equal(jul2025.netIncome, 0);
});

test("includes itemized expense categories with their own labels", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  const jan = result.get("2026-01");
  assert.ok("Administration Expen" in jan.expense);
  assert.ok("Salaries & Wages" in jan.expense);
  assert.equal(jan.expense["Administration Expen"], 515.05);
});
