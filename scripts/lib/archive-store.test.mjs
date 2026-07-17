import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { hashContent, archiveFile, findDuplicateHash, loadManifest } from "./archive-store.mjs";

const TMP_DIR = "scripts/__fixtures__/tmp-archive-store";

test("hashContent is deterministic for identical buffers", () => {
  const a = hashContent(Buffer.from("hello"));
  const b = hashContent(Buffer.from("hello"));
  assert.equal(a, b);
});

test("hashContent differs for different buffers", () => {
  const a = hashContent(Buffer.from("hello"));
  const b = hashContent(Buffer.from("world"));
  assert.notEqual(a, b);
});

test("archiveFile writes a new file and records it in the batch manifest", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const result = await archiveFile(TMP_DIR, "2026-01", "cashflow-t12", "pdf", Buffer.from("report-a"), {
    sourceEmailSubject: "January 2026 Update",
  });
  assert.equal(result.written, true);
  const written = await readFile(`${TMP_DIR}/2026-01/cashflow-t12.pdf`, "utf8");
  assert.equal(written, "report-a");
  const manifest = await loadManifest(`${TMP_DIR}/2026-01`);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].docType, "cashflow-t12");
  assert.equal(manifest.files[0].sourceEmailSubject, "January 2026 Update");
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("archiveFile skips an exact duplicate found in a different batch", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await archiveFile(TMP_DIR, "2025-05", "cashflow-t12", "pdf", Buffer.from("same-report"), {});
  const result = await archiveFile(TMP_DIR, "2025-08", "cashflow-t12", "pdf", Buffer.from("same-report"), {});
  assert.equal(result.written, false);
  assert.equal(result.duplicateOf, "2025-05");
  await assert.rejects(() => readFile(`${TMP_DIR}/2025-08/cashflow-t12.pdf`, "utf8"));
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("findDuplicateHash returns null for a brand-new hash", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await archiveFile(TMP_DIR, "2026-01", "cashflow-t12", "pdf", Buffer.from("report-a"), {});
  const result = await findDuplicateHash(TMP_DIR, hashContent(Buffer.from("totally-different")));
  assert.equal(result, null);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("loadManifest returns an empty files array when no manifest exists yet", async () => {
  const manifest = await loadManifest("scripts/__fixtures__/tmp-archive-store-nonexistent");
  assert.deepEqual(manifest, { files: [] });
});
