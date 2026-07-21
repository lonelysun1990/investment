import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveMonthAbbr,
  extractDirectStatement,
  extractVacantUnitNarrative,
} from "./extract-mcneil-occupancy-narrative.mjs";

const OCT_2024_FIXTURE = "scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt";
const JUN_2026_FIXTURE = "scripts/__fixtures__/mcneil-emails/2026-06-narrative.txt";

test("resolveMonthAbbr resolves the same-month case", () => {
  assert.equal(resolveMonthAbbr("Oct", "2024-10"), "2024-10");
});

test("resolveMonthAbbr resolves the prior-month case within the same year", () => {
  assert.equal(resolveMonthAbbr("Sep", "2024-10"), "2024-09");
});

test("resolveMonthAbbr handles year rollover when the abbreviation is later in the calendar than the anchor month", () => {
  assert.equal(resolveMonthAbbr("Dec", "2026-01"), "2025-12");
});

test("resolveMonthAbbr throws on an unrecognized abbreviation", () => {
  assert.throws(() => resolveMonthAbbr("Xyz", "2024-10"));
});

test("extractDirectStatement parses the real Oct 2024 email's 'Occupancy: X% (MonA) vs. Y% (MonB)' line", async () => {
  const text = await readFile(OCT_2024_FIXTURE, "utf8");
  const result = extractDirectStatement(text, "2024-10");
  assert.deepEqual(result, { "2024-09": 90.6, "2024-10": 87.5 });
});

test("extractDirectStatement returns null when the email has no direct-statement line", async () => {
  const text = await readFile(JUN_2026_FIXTURE, "utf8");
  assert.equal(extractDirectStatement(text, "2026-06"), null);
});

test("extractVacantUnitNarrative computes occupancy from the real June 2026 email's vacant-unit count", async () => {
  const text = await readFile(JUN_2026_FIXTURE, "utf8");
  const result = extractVacantUnitNarrative(text, "2026-06", 32);
  assert.deepEqual(result, { "2026-06": 90.6 });
});

test("extractVacantUnitNarrative returns null when the email has no vacant-unit line", async () => {
  const text = await readFile(OCT_2024_FIXTURE, "utf8");
  assert.equal(extractVacantUnitNarrative(text, "2024-10", 32), null);
});
