import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractPdfText(pdfPath, pageRange) {
  const args = ["-layout"];
  if (pageRange) args.push("-f", String(pageRange[0]), "-l", String(pageRange[1]));
  args.push(pdfPath, "-");
  const { stdout } = await execFileAsync("pdftotext", args);
  return stdout;
}

export async function extractPagesFromPdf(pdfPath) {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
  const pages = stdout.split("\f");
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages;
}
