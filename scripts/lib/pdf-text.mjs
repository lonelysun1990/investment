import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractPageText(pdfPath, pageNum) {
  try {
    const { stdout } = await execFileAsync("pdftotext", [
      "-f", String(pageNum),
      "-l", String(pageNum),
      "-layout",
      pdfPath,
      "-",
    ]);
    return stdout;
  } catch (err) {
    throw new Error(
      `pdftotext failed for ${pdfPath} page ${pageNum}: ${err.message}`
    );
  }
}
