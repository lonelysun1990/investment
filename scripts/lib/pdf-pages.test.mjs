import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText, extractPagesFromPdf } from "./pdf-pages.mjs";

test("extractPdfText extracts the whole file when no pageRange is given", async () => {
  const text = await extractPdfText("scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf");
  assert.match(text, /Trailing Profit And Loss Detail/);
  assert.match(text, /TOTAL EXPENSE/);
});

test("extractPdfText extracts only the requested page range from a real multi-page file", async () => {
  const text = await extractPdfText("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf", [3, 3]);
  assert.match(text, /Trailing Profit And Loss Detail/);
  assert.doesNotMatch(text, /Rent Roll Summary/, "page 3 alone must not contain the rent roll section");
});

test("extractPagesFromPdf splits a real 13-page bundle into 13 page-text entries", async () => {
  const pages = await extractPagesFromPdf("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf");
  assert.equal(pages.length, 13);
  assert.match(pages[0], /Balance Sheet/);
  assert.match(pages[2], /Trailing Profit And Loss Detail/);
  assert.match(pages[9], /Rent Roll Summary/);
  assert.match(pages[11], /Aged Receivables Summary/);
  assert.match(pages[12], /Cash Flow Statement Detail/);
});
