import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { findViolations } from "./audit-no-api-calls.mjs";

const TMP_DIR = "scripts/__fixtures__/tmp-audit-scripts";

test("flags a direct call to api.cashflowportal.com", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(`${TMP_DIR}/bad.mjs`, 'const resp = await page.request.post("https://api.cashflowportal.com/graphql/");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, `${TMP_DIR}/bad.mjs`);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("flags reuse of the __access_token cookie", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(`${TMP_DIR}/bad.mjs`, 'const token = cookies.find(c => c.name === "__access_token");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 1);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("passes clean files with no violations", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(`${TMP_DIR}/good.mjs`, 'await page.goto("https://whitepagodagroup.cashflowportal.com/app");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 0);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("scans subdirectories recursively", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(`${TMP_DIR}/nested`, { recursive: true });
  await writeFile(`${TMP_DIR}/nested/bad.mjs`, 'fetch("https://api.cashflowportal.com/v1/deals/1");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 1);
  await rm(TMP_DIR, { recursive: true, force: true });
});
