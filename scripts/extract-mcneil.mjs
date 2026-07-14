import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMoney } from "./lib/money.mjs";

const execFileAsync = promisify(execFile);

const MONTH_ABBR = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function toMonthKey(label) {
  const match = label.match(/^(\w{3})\s+(\d{4})$/);
  if (!match) throw new Error(`extract-mcneil: unrecognized month header "${label}"`);
  return `${match[2]}-${MONTH_ABBR[match[1]]}`;
}

async function fullText(pdfPath) {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
  return stdout;
}

function splitRow(line) {
  const moneyToken = /-?\(?\$?[\d,]+\.\d{2}\)?/;
  const firstMoneyMatch = line.match(new RegExp(`\\s{2,}${moneyToken.source}`));
  if (!firstMoneyMatch) return null;
  const label = line.slice(0, firstMoneyMatch.index).trim();
  const rest = line.slice(firstMoneyMatch.index).trim();
  const values = rest.split(/\s{2,}/).filter(Boolean).map(parseMoney);
  return { label, values };
}

export async function extractMcneilPnl(pdfPath) {
  const text = await fullText(pdfPath);
  const lines = text.split("\n");

  const headerLine = lines.find((l) => /^Account\s+\w{3} \d{4}/.test(l.trim()));
  if (!headerLine) throw new Error("extract-mcneil: could not find table header row");
  const monthLabels = headerLine
    .replace(/^Account/, "")
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean);
  const monthKeys = monthLabels.slice(0, -1).map(toMonthKey);

  const months = new Map();
  for (const key of monthKeys) {
    months.set(key, {
      income: { rental: 0, other: 0, total: 0 },
      expense: { total: 0 },
      noi: 0,
      debtService: 0,
      capitalImprovements: 0,
      netIncome: 0,
    });
  }

  let reachedNetIncome = false;
  for (const rawLine of lines) {
    if (reachedNetIncome) break;
    const row = splitRow(rawLine);
    if (!row) continue;
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;

    monthKeys.forEach((key, i) => {
      const rec = months.get(key);
      const value = perMonth[i];
      if (row.label === "Total Rental Income") rec.income.rental = value;
      else if (row.label === "Total Other Income") rec.income.other = value;
      else if (row.label === "TOTAL INCOME") rec.income.total = value;
      else if (row.label === "NET OPERATING INCOME") rec.noi = value;
      else if (row.label === "Total Debt Service") rec.debtService = value;
      else if (row.label === "Total Capital Improvements") rec.capitalImprovements = value;
      else if (row.label === "NET INCOME") {
        rec.netIncome = value;
      } else if (/^Total /.test(row.label)) {
        rec.expense[row.label.replace(/^Total /, "")] = value;
      }
    });

    if (row.label === "NET INCOME") reachedNetIncome = true;
  }

  return months;
}
