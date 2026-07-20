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
