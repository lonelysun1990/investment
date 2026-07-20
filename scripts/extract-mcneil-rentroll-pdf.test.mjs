import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRentRollPdf } from "./extract-mcneil-rentroll-pdf.mjs";

test("extracts occupancy from the real 9/30/2025 Rent Roll Summary", async () => {
  const result = await extractRentRollPdf("scripts/__fixtures__/mcneil/2025-09-rentroll-summary.pdf");
  assert.equal(result.asOfDate, "2025-09-30");
  assert.equal(result.totalUnits, 32);
  assert.equal(result.occupiedUnits, 29);
  assert.equal(result.vacantUnits, 3);
  assert.equal(result.occupancyPct, 90.6);
});

test("extracts occupancy from the real 12/31/2025 Rent Roll Summary", async () => {
  const result = await extractRentRollPdf("scripts/__fixtures__/mcneil/2025-12-rentroll-summary.pdf");
  assert.equal(result.asOfDate, "2025-12-31");
  assert.equal(result.occupiedUnits, 27);
  assert.equal(result.vacantUnits, 5);
  assert.equal(result.occupancyPct, 84.4);
});

test("accepts a pageRange and extracts only that section from a larger bundled file", async () => {
  const result = await extractRentRollPdf("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf", [10, 11]);
  assert.equal(result.asOfDate, "2025-09-30");
  assert.equal(result.occupancyPct, 90.6);
});

test("throws a clear error when the Property Occupancy summary is missing", async () => {
  await assert.rejects(
    () => extractRentRollPdf("scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf"),
    /could not find Property Occupancy summary/
  );
});
