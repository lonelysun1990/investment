import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function loadRecords(jsonPath) {
  try {
    const raw = await readFile(jsonPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function saveRecords(jsonPath, records) {
  const sortedKeys = Object.keys(records).sort();
  const sorted = {};
  for (const key of sortedKeys) sorted[key] = records[key];
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

export function mergeRecord(records, month, record) {
  return { ...records, [month]: record };
}
