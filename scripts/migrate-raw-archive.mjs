// scripts/migrate-raw-archive.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { archiveFile } from "./lib/archive-store.mjs";
import { resolveBatchDate } from "./lib/batch-date.mjs";
import { extractTextFromPdf } from "./lib/offering-doc.mjs";

export async function planMigration(oldRawDir, dealConfig) {
  const monthDirs = (await readdir(oldRawDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const plan = [];
  for (const monthDir of monthDirs) {
    const dirPath = path.join(oldRawDir, monthDir);
    const files = (await readdir(dirPath, { withFileTypes: true })).filter(
      (f) => f.isFile() && f.name !== "manifest.json"
    );
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      const buffer = await readFile(filePath);
      const ext = path.extname(file.name).replace(".", "");
      const text = ext.toLowerCase() === "pdf" ? await extractTextFromPdf(filePath).catch(() => "") : "";
      const docType = dealConfig.classifyDoc({ filename: file.name, text });
      const harvestedAt = `${monthDir}-01T00:00:00.000Z`;
      const { batchKey, source } = resolveBatchDate({ text, harvestedAt });
      plan.push({ oldPath: filePath, batchKey, docType, ext, buffer, source, harvestedAt });
    }
  }
  return plan;
}

export async function runMigration(oldRawDir, newRawDir, dealConfig) {
  const plan = await planMigration(oldRawDir, dealConfig);
  const results = [];
  for (const entry of plan) {
    const result = await archiveFile(newRawDir, entry.batchKey, entry.docType, entry.ext, entry.buffer, {
      batchDateSource: entry.source,
      harvestedAt: entry.harvestedAt,
    });
    results.push({ ...entry, ...result });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , dealSlug, oldDir, newDir] = process.argv;
  if (!dealSlug || !oldDir || !newDir) {
    console.error("Usage: node scripts/migrate-raw-archive.mjs <dealSlug> <oldRawDir> <newRawDir>");
    process.exit(1);
  }
  const dealConfig = await import(`./deals/${dealSlug}.config.mjs`);
  const results = await runMigration(oldDir, newDir, dealConfig);
  for (const r of results) {
    console.log(`${r.written ? "moved" : "skipped (dup of " + r.duplicateOf + ")"}: ${r.oldPath} -> ${r.batchKey}/${r.docType}.${r.ext}`);
  }
}
