import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("pdftotext", ["-layout", "/tmp/mcneil-2025.pdf", "-"]);

function parseMoney(s) {
  s = s.replace(/[$,]/g, "").trim();
  if (s.startsWith("(") && s.endsWith(")")) return -parseFloat(s.slice(1, -1));
  return parseFloat(s) || 0;
}

const lines = stdout.split("\n");
const monthKeys = ["2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12"];

let headerIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (/Jan 2025\s+Feb 2025\s+Mar 2025/.test(lines[i])) { headerIdx = i; break; }
}

const months = new Map();
for (const key of monthKeys) {
  months.set(key, { income: { rental: 0, other: 0, total: 0 }, expense: { total: 0 }, noi: 0, debtService: 0, capitalImprovements: 0, netIncome: 0 });
}

// New regex: exclude account numbers (NNNN.NNN) from money matches
// Account numbers: 4 digits, dot, 3 digits = \d{4}\.\d{3}
// Money values: have comma separators OR start with paren
const moneyRegex = /(-?\d{1,3}(?:,\d{3})*\.\d{2}|\(\d{1,3}(?:,\d{3})*\.\d{2}\)|-?\d+\.\d{2}(?!\d))/g;

for (let i = headerIdx + 1; i < lines.length; i++) {
  const line = lines[i];
  const moneyTokens = line.match(moneyRegex);
  if (!moneyTokens || moneyTokens.length < 12) continue;
  
  const rawValues = moneyTokens.map(parseMoney);
  // Some lines have a leading pseudo-token (e.g. "000.00" from account number). Skip it.
  const start = rawValues.length === 15 && rawValues[0] === 0 ? 1 : 0;
  const values = rawValues.slice(start, start + 12);
  if (values.length < 12) continue;

  const firstMatch = new RegExp(moneyRegex.source, moneyRegex.flags).exec(line);
  if (!firstMatch) continue;
  
  const label = line.substring(0, firstMatch.index).trim();
  
  for (let idx = 0; idx < 12; idx++) {
    const rec = months.get(monthKeys[idx]);
    const v = values[idx];
    
    if (label.includes("Total Net Rental Income") && !label.includes("Other")) rec.income.rental = v;
    else if (label.includes("Total Other Rental Income")) rec.income.other = v;
    else if (label === "TOTAL INCOME" || label.endsWith("TOTAL INCOME")) rec.income.total = v;
    else if (label.includes("NET OPERATING INCOME") && !label.includes("NON")) rec.noi = v;
    else if (label.includes("NET INCOME") && !label.includes("OPERATING") && !label.includes("NON")) rec.netIncome = v;
    else if (label.match(/9500.*Total\s+Capital/) || label.includes("Total Capital Expenditures")) rec.capitalImprovements = v;
    else if (/\bTotal\b/.test(label) && !/Income|Capital|NON.OPERATING|NET/.test(label)) {
      const cat = label.replace(/^\d+\.\d+\s*/, "").replace(/^Total\s+/, "").trim();
      if (cat) rec.expense[cat] = (rec.expense[cat] || 0) + v;
    }
  }
}

for (const [key, rec] of months) {
  rec.debtService = Math.round((rec.noi - rec.capitalImprovements - rec.netIncome) * 100) / 100;
  const expTotal = Object.entries(rec.expense).filter(([k]) => k !== "total").reduce((s, [,v]) => s + v, 0);
  rec.expense.total = Math.round(expTotal * 100) / 100;
  
  console.log(key, "Inc:", rec.income.total, "Exp:", rec.expense.total, "NOI:", rec.noi, "CapEx:", rec.capitalImprovements, "Debt:", rec.debtService, "Net:", rec.netIncome);
}

const existing = JSON.parse(await readFile("data/mcneil.json", "utf8"));
for (const [key, rec] of months) {
  existing[key] = { ...rec, month: key, sourceFile: "deal_updates/KAZDI/951d26e1-...pdf", extraction: { method: "deterministic", confidence: "high" } };
}
await writeFile("data/mcneil.json", JSON.stringify(existing, null, 2) + "\n");
console.log("\nMcNeil:", Object.keys(existing).length, "months");
