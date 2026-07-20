import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMoney } from "./money.mjs";

const execFileAsync = promisify(execFile);

export async function extractTextFromPdf(pdfPath) {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
    return stdout;
  } catch (err) {
    throw new Error(
      `offering-doc: pdftotext failed for ${pdfPath}: ${err.message}`
    );
  }
}

export function findTotalRaise(text, labelPattern) {
  for (const line of text.split("\n")) {
    if (!labelPattern.test(line)) continue;
    const amounts = line.match(/\$?[\d,]+(?:\.\d{2})?/g);
    if (!amounts) continue;
    const values = amounts.map((a) => parseMoney(a.replace(/^\$/, "")));
    const largest = Math.max(...values);
    if (largest > 0) return largest;
  }
  return null;
}

export async function extractTotalRaise(pdfPath, labelPattern) {
  const text = await extractTextFromPdf(pdfPath);
  return findTotalRaise(text, labelPattern);
}
