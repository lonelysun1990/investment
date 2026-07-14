import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney } from "./money.mjs";

test("parses plain decimal", () => {
  assert.equal(parseMoney("2,527.04"), 2527.04);
});

test("parses accounting-negative parens", () => {
  assert.equal(parseMoney("(9,347.72)"), -9347.72);
});

test("parses dollar-sign whole numbers", () => {
  assert.equal(parseMoney("$18,449"), 18449);
});

test("parses zero", () => {
  assert.equal(parseMoney("0.00"), 0);
});

test("trims surrounding whitespace", () => {
  assert.equal(parseMoney("   16,836.63   "), 16836.63);
});

test("throws on non-numeric input", () => {
  assert.throws(() => parseMoney("N/A"), TypeError);
});

test("throws on empty string", () => {
  assert.throws(() => parseMoney(""), TypeError);
});
