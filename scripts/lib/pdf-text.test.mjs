import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPageText } from "./pdf-text.mjs";

const LEGACY_PDF = "scripts/__fixtures__/legacy/2026-05-investor-update.pdf";

test("extracts real text from Legacy page 3 (narrative page)", async () => {
  const text = await extractPageText(LEGACY_PDF, 3);
  assert.match(text, /We ended May with occupancy at 74%/);
  assert.match(text, /Net Rental Income for May was \$18,449/);
});

test("returns near-empty string for Legacy page 4 (flattened image page)", async () => {
  const text = await extractPageText(LEGACY_PDF, 4);
  assert.ok(text.trim().length < 5, `expected near-empty text, got: "${text}"`);
});

test("throws a clear error for a page number beyond the document", async () => {
  await assert.rejects(() => extractPageText(LEGACY_PDF, 999));
});
