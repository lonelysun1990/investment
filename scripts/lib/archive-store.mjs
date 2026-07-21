import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

export function hashContent(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function resolveArchiveRoot() {
  const gitCommonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
    encoding: "utf8",
  }).trim();
  const mainRoot = path.dirname(gitCommonDir);
  return path.join(mainRoot, "data", "raw");
}

export async function loadManifest(batchDir) {
  try {
    const raw = await readFile(path.join(batchDir, "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return { files: [] };
    throw err;
  }
}

export async function saveManifest(batchDir, manifest) {
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export async function findDuplicateHash(dealRawDir, contentHash) {
  let batchNames;
  try {
    batchNames = (await readdir(dealRawDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const batchName of batchNames) {
    const manifest = await loadManifest(path.join(dealRawDir, batchName));
    if (manifest.files.some((f) => f.contentHash === contentHash)) return batchName;
  }
  return null;
}

// archiveFile must only be called sequentially (never concurrently) for the same batch directory.
// All current callers in this plan use `for`...`await`, not `Promise.all`.
export async function archiveFile(dealRawDir, batchKey, docType, ext, buffer, meta = {}) {
  const contentHash = hashContent(buffer);
  const duplicateOf = await findDuplicateHash(dealRawDir, contentHash);
  if (duplicateOf) {
    return { written: false, duplicateOf };
  }
  const batchDir = path.join(dealRawDir, batchKey);
  const fileName = `${docType}.${ext}`;
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, fileName), buffer);

  const manifest = await loadManifest(batchDir);
  // Remove any existing entry with the same fileName to prevent stale manifest entries on overwrite
  manifest.files = manifest.files.filter((f) => f.fileName !== fileName);
  manifest.files.push({
    docType,
    fileName,
    contentHash,
    sections: meta.sections ?? [{ docType, pageRange: null }],
    sourceEmailSubject: meta.sourceEmailSubject ?? null,
    harvestedAt: meta.harvestedAt ?? new Date().toISOString(),
    batchDateSource: meta.batchDateSource ?? "content",
  });
  await saveManifest(batchDir, manifest);
  return { written: true };
}
