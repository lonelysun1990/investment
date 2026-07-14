import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export async function renderPageToPng(pdfPath, pageNum, outPngPath) {
  const prefix = outPngPath.replace(/\.png$/, "");
  try {
    await execFileAsync("pdftoppm", [
      "-png", "-f", String(pageNum), "-l", String(pageNum), "-r", "150",
      pdfPath, prefix,
    ]);
  } catch (err) {
    throw new Error(`pdftoppm failed for ${pdfPath} page ${pageNum}: ${err.message}`);
  }
  const candidates = [
    `${prefix}-${pageNum}.png`,
    `${prefix}-${String(pageNum).padStart(2, "0")}.png`,
    `${prefix}.png`,
  ];
  for (const candidate of candidates) {
    try {
      await rename(candidate, outPngPath);
      return;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`pdftoppm did not produce an output file for prefix ${prefix}`);
}
