import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const BANNED_PATTERNS = [/api\.cashflowportal\.com/, /__access_token/];

export async function findViolations(dirPath) {
  const violations = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      violations.push(...(await findViolations(fullPath)));
      continue;
    }
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js")) continue;
    if (entry.name === "audit-no-api-calls.test.mjs") continue;
    if (entry.name === "audit-no-api-calls.mjs") continue;
    const content = await readFile(fullPath, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ file: fullPath, line: i + 1, match: line.trim() });
        }
      }
    });
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await findViolations("scripts");
  if (violations.length > 0) {
    console.error("Compliance audit FAILED — direct CashFlowPortal API access found:");
    for (const v of violations) console.error(`  ${v.file}:${v.line}: ${v.match}`);
    process.exit(1);
  }
  console.log("Compliance audit passed — no direct API access found in scripts/.");
}
