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

test("parseDistributionText extracts quarter+amount from a real multi-line table row", () => {
  // Each entry is one table row's `tr.innerText` -- verified live: a single
  // row spans many newlines because name/status/bank cells wrap internally,
  // so the quarter label and dollar amount live on different split "lines".
  const rows = [
    "\tClass A - Limited partners\tOperating income\t2026 Q2\tACH\t\nChase ending in, 6772\n\t\nCompleted\n\n\tApr 01, 2026 - Jun 30, 2026\tJul 08, 2026\tJul 08, 2026\t$648.14",
    "\tClass A - Limited partners\tOperating income\t2025 Q3\tACH\t\nChase ending in, 6772\n\t\nCompleted\n\n\tJul 01, 2025 - Sep 30, 2025\tOct 08, 2025\tOct 08, 2025\t$699.99",
  ];
  const result = parseDistributionText(rows);
  assert.deepEqual(result, [
    { date: "2026-Q2", amount: 648.14 },
    { date: "2025-Q3", amount: 699.99 },
  ]);
});

test("parseDistributionText handles the alternate 'Q2 2026' quarter ordering", () => {
  const rows = [
    "\tClass A - Limited partners\tOperating income\tQ1 2026\tACH\t\nChase ending in, 6772\n\t\nCompleted\n\n\tJan 01, 2026 - Mar 31, 2026\tApr 08, 2026\t$1,648.14",
  ];
  const result = parseDistributionText(rows);
  assert.deepEqual(result, [{ date: "2026-Q1", amount: 1648.14 }]);
});

test("parseDistributionText skips rows missing a quarter or a dollar amount", () => {
  const rows = [
    "\tClass A - Limited partners\tOperating income\t2026 Q2\tACH\t\nPending\n\n\tno amount recorded yet",
    "\tSummary row with a $500.00 amount but no quarter label anywhere",
    "\tClass A - Limited partners\tOperating income\t2025 Q4\tACH\t\nCompleted\n\n\tOct 01, 2025 - Dec 31, 2025\tJan 08, 2026\t$648.14",
  ];
  const result = parseDistributionText(rows);
  assert.deepEqual(result, [{ date: "2025-Q4", amount: 648.14 }]);
});

test("parseOwnershipPct extracts a percentage followed by 'ownership'", () => {
  assert.equal(parseOwnershipPct("Your ownership: 2.59% ownership of the deal"), 2.59);
});

test("parseOwnershipPct returns null when no percentage is present", () => {
  assert.equal(parseOwnershipPct("No ownership figures shown yet"), null);
});
