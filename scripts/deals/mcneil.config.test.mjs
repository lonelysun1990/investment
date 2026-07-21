import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc, distributionLabel, totalRaiseLabel, investmentDeckRaiseLabel } from "./mcneil.config.mjs";
import { extractPagesFromPdf } from "../lib/pdf-pages.mjs";
import { extractTotalRaise } from "../lib/offering-doc.mjs";

test("classifies a twelve-month cash flow PDF as cashflow-t12", () => {
  const pages = ["Twelve Month Cash Flow Statement Expanded Detail\nJune 2026 - Accrual"];
  assert.deepEqual(classifyDoc({ filename: "cashflow.pdf", pages }), [{ docType: "cashflow-t12", pageRange: [1, 1] }]);
});

test("classifies a twelve-month profit and loss PDF as cashflow-t12", () => {
  const pages = ["Twelve Month Profit and Loss\nJanuary 2024 - December 2024"];
  assert.deepEqual(classifyDoc({ filename: "T12.pdf", pages }), [{ docType: "cashflow-t12", pageRange: [1, 1] }]);
});

test("classifies a balance sheet PDF as balance-sheet", () => {
  const pages = ["McNeil Star\nGolden Group Multifamily LLC\nBalance Sheet\nDecember 2024"];
  assert.deepEqual(classifyDoc({ filename: "BalanceSheet.pdf", pages }), [{ docType: "balance-sheet", pageRange: [1, 1] }]);
});

test("classifies an xlsx file as rentroll regardless of content", () => {
  assert.deepEqual(classifyDoc({ filename: "rentroll.xlsx", pages: [] }), [{ docType: "rentroll", pageRange: null }]);
});

test("classifies an offering memorandum as offering-doc", () => {
  const pages = ["McNeil Star Apartments Private Placement Memorandum"];
  assert.deepEqual(classifyDoc({ filename: "offering.pdf", pages }), [{ docType: "offering-doc", pageRange: [1, 1] }]);
});

test("returns unknown for unrecognized content", () => {
  assert.deepEqual(classifyDoc({ filename: "random.pdf", pages: ["Just some text"] }), [{ docType: "unknown", pageRange: [1, 1] }]);
});

test("classifies an offering memorandum that also mentions balance sheet/cash flow as offering-doc, not the generic type", () => {
  const pages = ["McNeil Star Apartments Private Placement Memorandum\n\nExhibit C: Balance Sheet and Twelve Month Cash Flow Statement"];
  assert.deepEqual(classifyDoc({ filename: "offering.pdf", pages }), [{ docType: "offering-doc", pageRange: [1, 1] }]);
});

test("classifies a real 13-page bundled report into 5 distinct sections by page range", async () => {
  const pages = await extractPagesFromPdf("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf");
  const sections = classifyDoc({ filename: "balance-sheet.pdf", pages });
  assert.deepEqual(sections, [
    { docType: "balance-sheet", pageRange: [1, 2] },
    { docType: "trailing-pnl-detail", pageRange: [3, 9] },
    { docType: "rentroll-pdf", pageRange: [10, 11] },
    { docType: "aged-receivables", pageRange: [12, 12] },
    { docType: "cashflow-detail", pageRange: [13, 13] },
  ]);
});

test("distributionLabel matches the exact 'Member's Distribution' row label, not its Total subtotal", () => {
  assert.ok(distributionLabel.test("Member's Distribution"));
  assert.ok(!distributionLabel.test("Total Member's Contribut"));
});

test("totalRaiseLabel matches common offering-amount phrasing", () => {
  assert.ok(totalRaiseLabel.test("Total Offering Amount: $1,930,000"));
  assert.ok(totalRaiseLabel.test("Total Capital Raised 1,300,000"));
});

test("totalRaiseLabel matches the real McNeil PPM's Sources of Funds equity line", () => {
  assert.ok(totalRaiseLabel.test("Equity (from the proceeds of this Offering)                                 $1,500,000"));
});

test("totalRaiseLabel does not match a bare grand-total line that isn't specifically about the offering amount", () => {
  assert.ok(!totalRaiseLabel.test("Total"));
  assert.ok(!totalRaiseLabel.test("                                                Total                        $2,698,000"));
});

test("investmentDeckRaiseLabel extracts the real capital-raise figure from the Investment Deck's ACQUSITION SUMMARY table", async () => {
  const result = await extractTotalRaise(
    "scripts/__fixtures__/mcneil/2024-investment-deck-acquisition-summary.pdf",
    investmentDeckRaiseLabel
  );
  assert.equal(result, 1300000);
});
