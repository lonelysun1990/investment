import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "./pdf-pages.mjs";

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
