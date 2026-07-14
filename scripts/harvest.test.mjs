import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmailSubjectMonth } from "./harvest.mjs";

test("parses Legacy's 'Month Year Update' subject format", () => {
  assert.equal(parseEmailSubjectMonth("The Legacy Apt: May 2026 Update"), "2026-05");
  assert.equal(parseEmailSubjectMonth("The Legacy Apt: Feb 2026 Update"), "2026-02");
});

test("parses McNeil's 'Month Year' subject format (no 'Update' suffix)", () => {
  assert.equal(parseEmailSubjectMonth("McNeil Investment: June 2026"), "2026-06");
  assert.equal(parseEmailSubjectMonth("McNeil Investment: Dec 2025"), "2025-12");
});

test("parses full month names as well as three-letter abbreviations", () => {
  assert.equal(parseEmailSubjectMonth("The Legacy Apt: March 2026 Update"), "2026-03");
  assert.equal(parseEmailSubjectMonth("McNeil Investment: Apr 2026"), "2026-04");
});

test("returns null for K-1 and closing-update subjects, not a report", () => {
  assert.equal(parseEmailSubjectMonth("The Legacy Apt - 2025 Form K-1 Uploaded"), null);
  assert.equal(parseEmailSubjectMonth("The Legacy Apartment - Closing Update"), null);
  assert.equal(parseEmailSubjectMonth("McNeil Star Apt - 2025 Form K-1"), null);
});
