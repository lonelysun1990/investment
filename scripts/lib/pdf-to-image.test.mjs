import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderPageToPng } from "./pdf-to-image.mjs";

const FIXTURE = "scripts/__fixtures__/legacy/2026-05-investor-update.pdf";

test("renders a PDF page to a non-empty PNG file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pdf-to-image-test-"));
  const outPath = path.join(dir, "page4.png");
  await renderPageToPng(FIXTURE, 4, outPath);
  const info = await stat(outPath);
  assert.ok(info.size > 1000, `expected a real PNG, got ${info.size} bytes`);
  await rm(dir, { recursive: true });
});
