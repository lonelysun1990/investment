import { test } from "node:test";
import assert from "node:assert/strict";
import { findTotalRaise } from "./offering-doc.mjs";

test("finds the largest dollar amount on a line matching the label pattern", () => {
  const text = "Summary of Terms\nTotal Offering Amount: $1,930,000\nMinimum Investment: $50,000\n";
  const result = findTotalRaise(text, /Total Offering Amount/i);
  assert.equal(result, 1930000);
});

test("returns null when no line matches the label pattern", () => {
  const text = "Summary of Terms\nMinimum Investment: $50,000\n";
  const result = findTotalRaise(text, /Total Offering Amount/i);
  assert.equal(result, null);
});

test("handles a comma-formatted amount without a dollar sign", () => {
  const text = "Total Capital Raised 1,300,000\n";
  const result = findTotalRaise(text, /Total Capital Raised/i);
  assert.equal(result, 1300000);
});

test("picks the largest amount on the matching line when several numbers appear", () => {
  const text = "Total Offering Amount: $1,930,000 (50 units at $38,600)\n";
  const result = findTotalRaise(text, /Total Offering Amount/i);
  assert.equal(result, 1930000);
});
