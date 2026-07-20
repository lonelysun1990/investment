import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmailSubjectMonth, parseDistributionText, parseOwnershipPct } from "./harvest.mjs";

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

test("parseDistributionText extracts quarter and amount from 'Q3 2025' style rows", () => {
  const text = "Distribution History\nQ3 2025   $699.99\nQ4 2025   $648.14\n";
  const result = parseDistributionText(text);
  assert.deepEqual(result, [
    { date: "2025-Q3", amount: 699.99 },
    { date: "2025-Q4", amount: 648.14 },
  ]);
});

test("parseDistributionText extracts rows in '2026-Q2' style too", () => {
  const text = "2026-Q1   $648.14\n2026-Q2   $648.14\n";
  const result = parseDistributionText(text);
  assert.deepEqual(result, [
    { date: "2026-Q1", amount: 648.14 },
    { date: "2026-Q2", amount: 648.14 },
  ]);
});

test("parseOwnershipPct extracts a percentage followed by 'ownership'", () => {
  assert.equal(parseOwnershipPct("Your ownership: 2.59% ownership of the deal"), 2.59);
});

test("parseOwnershipPct returns null when no percentage is present", () => {
  assert.equal(parseOwnershipPct("No ownership figures shown yet"), null);
});
