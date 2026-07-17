import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc, distributionLabel, totalRaiseLabel } from "./mcneil.config.mjs";

test("classifies a twelve-month cash flow PDF as cashflow-t12", () => {
  const text = "Twelve Month Cash Flow Statement Expanded Detail\nJune 2026 - Accrual";
  assert.equal(classifyDoc({ filename: "cashflow.pdf", text }), "cashflow-t12");
});

test("classifies a twelve-month profit and loss PDF as cashflow-t12", () => {
  const text = "Twelve Month Profit and Loss\nJanuary 2024 - December 2024";
  assert.equal(classifyDoc({ filename: "T12.pdf", text }), "cashflow-t12");
});

test("classifies a balance sheet PDF as balance-sheet", () => {
  const text = "McNeil Star\nGolden Group Multifamily LLC\nBalance Sheet\nDecember 2024";
  assert.equal(classifyDoc({ filename: "BalanceSheet.pdf", text }), "balance-sheet");
});

test("classifies an xlsx file as rentroll regardless of content", () => {
  assert.equal(classifyDoc({ filename: "rentroll.xlsx", text: "" }), "rentroll");
});

test("classifies an offering memorandum as offering-doc", () => {
  const text = "McNeil Star Apartments Private Placement Memorandum";
  assert.equal(classifyDoc({ filename: "offering.pdf", text }), "offering-doc");
});

test("returns unknown for unrecognized content", () => {
  assert.equal(classifyDoc({ filename: "random.pdf", text: "Just some text" }), "unknown");
});

test("distributionLabel matches the exact 'Member's Distribution' row label, not its Total subtotal", () => {
  assert.ok(distributionLabel.test("Member's Distribution"));
  assert.ok(!distributionLabel.test("Total Member's Contribut"));
});

test("totalRaiseLabel matches common offering-amount phrasing", () => {
  assert.ok(totalRaiseLabel.test("Total Offering Amount: $1,930,000"));
  assert.ok(totalRaiseLabel.test("Total Capital Raised 1,300,000"));
});
