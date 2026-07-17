import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc, distributionLabel, totalRaiseLabel } from "./legacy.config.mjs";

test("classifies the monthly investor update PDF as monthly-update", () => {
  const text = "The Legacy Apartment May Update\nThe Legacy Apartment";
  assert.equal(classifyDoc({ filename: "report.pdf", text }), "monthly-update");
});

test("classifies an offering memorandum as offering-doc", () => {
  const text = "The Legacy Apartment Private Placement Memorandum";
  assert.equal(classifyDoc({ filename: "offering.pdf", text }), "offering-doc");
});

test("returns unknown for unrecognized content", () => {
  assert.equal(classifyDoc({ filename: "random.pdf", text: "Just some text" }), "unknown");
});

test("has no distribution label yet, since Legacy's reports don't itemize one", () => {
  assert.equal(distributionLabel, null);
});

test("totalRaiseLabel matches common offering-amount phrasing", () => {
  assert.ok(totalRaiseLabel.test("Total Offering Amount: $1,200,000"));
});
