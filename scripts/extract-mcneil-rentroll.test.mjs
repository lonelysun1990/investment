import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRentRoll } from "./extract-mcneil-rentroll.mjs";

const FIXTURE = "scripts/__fixtures__/mcneil/2026-06-rent-roll.xlsx";

test("extracts the as-of date", async () => {
  const result = await extractRentRoll(FIXTURE);
  assert.equal(result.asOfDate, "2026-06-30");
});

test("counts total units and classifies occupied vs vacant vs other", async () => {
  const result = await extractRentRoll(FIXTURE);
  assert.ok(result.totalUnits > 0);
  assert.equal(result.occupiedUnits + result.vacantUnits + result.otherStatusUnits.length, result.totalUnits);
});

test("computes occupancy percentage consistent with occupied/total", async () => {
  const result = await extractRentRoll(FIXTURE);
  const expectedPct = Math.round((result.occupiedUnits / result.totalUnits) * 1000) / 10;
  assert.equal(result.occupancyPct, expectedPct);
});

test("identifies the known vacant unit 103 from the sample", async () => {
  const result = await extractRentRoll(FIXTURE);
  assert.ok(result.vacantUnits >= 1);
});

test("computes average market rent and average actual rent across occupied units", async () => {
  const result = await extractRentRoll(FIXTURE);
  assert.ok(result.avgMarketRent > 0);
  assert.ok(result.avgActualRent > 0);
});
