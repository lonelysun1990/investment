import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractPageText } from "./lib/pdf-text.mjs";
import { parseMoney } from "./lib/money.mjs";
import { renderPageToPng } from "./lib/pdf-to-image.mjs";
import { callVisionLlm } from "./lib/vision-llm.mjs";

const NARRATIVE_PAGE = 3;

export async function extractNarrative(pdfPath) {
  const text = await extractPageText(pdfPath, NARRATIVE_PAGE);

  const occupancyMatch = text.match(/occupancy at (\d+)%/i);
  if (!occupancyMatch) {
    throw new Error(
      `extract-legacy: could not find occupancy percentage in ${pdfPath}`
    );
  }
  const occupancyPct = Number(occupancyMatch[1]);

  const preLeasedMatch = text.match(/pre-leased to (\d+)% occupancy/i);
  const preLeasedPct = preLeasedMatch ? Number(preLeasedMatch[1]) : null;

  const financialMatch = text.match(
    /Net Rental Income for \w+ was \$([\d,]+)\. Total revenue for the month was \$([\d,]+), which netted to an NOI of \$([\d,]+)/i
  );
  if (!financialMatch) {
    throw new Error(
      `extract-legacy: could not find Financial Overview summary sentence in ${pdfPath}`
    );
  }

  return {
    occupancyPct,
    preLeasedPct,
    statedRentalIncome: parseMoney(financialMatch[1]),
    statedTotalRevenue: parseMoney(financialMatch[2]),
    statedNoi: parseMoney(financialMatch[3]),
    narrative: text.trim(),
  };
}

const PNL_TABLE_PAGE = 4;
const NOI_CROSS_CHECK_TOLERANCE = 1;

const PNL_TABLE_PROMPT = `This image is a property-management "Trailing Profit and Loss" table with monthly columns (typically 5 months). Extract ALL months' columns, not just the latest. The leftmost visible month column is the earliest, the rightmost is the most recent. Respond with ONLY a JSON object, no prose or code fences, matching exactly this shape:
{
  "months": {
    "<YYYY-MM>": {
      "income": { "rental": number, "other": number, "total": number },
      "expense": { "<exact category label as printed>": number, ..., "total": number },
      "noi": number,
      "nonOperatingExpense": { "debtService": number, "otherNonOperating": number, "capitalImprovements": number, "total": number },
      "netIncome": number
    }
  }
}
Use the month label shown in the column header (e.g., "Jan 2026" → "2026-01"). Use negative numbers (not parentheses) for any value shown in parentheses in the image. Do not include currency symbols or commas in the numbers.`;

export async function extractPnlTable(config, pdfPath, month, opts = {}) {
  if (!config) {
    return { tablesByMonth: null, method: "unavailable", confidence: null };
  }
  const callVisionLlmImpl = opts.callVisionLlmImpl ?? callVisionLlm;

  const pngPath = path.join(tmpdir(), `legacy-pnl-${month}-${Date.now()}.png`);
  await renderPageToPng(pdfPath, PNL_TABLE_PAGE, pngPath);
  const imageBase64 = (await readFile(pngPath)).toString("base64");

  let responseText = await callVisionLlmImpl(config, imageBase64, PNL_TABLE_PROMPT);
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `extract-legacy: vision LLM response for ${month} was not valid JSON: ${responseText.slice(0, 200)}`
    );
  }

  const tablesByMonth = result.months ?? { [month]: result };

  const narrative = await extractNarrative(pdfPath);
  const latestMonthTable = tablesByMonth[month];
  const noiMatches = latestMonthTable
    ? Math.abs(Math.round(latestMonthTable.noi) - narrative.statedNoi) <= NOI_CROSS_CHECK_TOLERANCE
    : false;
  const revenueMatches = latestMonthTable
    ? Math.abs(Math.round(latestMonthTable.income.total) - narrative.statedTotalRevenue) <= NOI_CROSS_CHECK_TOLERANCE
    : false;

  return {
    tablesByMonth,
    method: "vision_llm",
    confidence: noiMatches && revenueMatches ? "high" : "low",
  };
}

export async function extractLegacyMonth(config, pdfPath, month, opts = {}) {
  const narrative = await extractNarrative(pdfPath);
  const { tablesByMonth, method, confidence } = await extractPnlTable(config, pdfPath, month, opts);

  if (!tablesByMonth) {
    return {
      [month]: {
        month,
        occupancyPct: narrative.occupancyPct,
        preLeasedPct: narrative.preLeasedPct,
        income: null,
        expense: null,
        noi: null,
        nonOperatingExpense: null,
        netIncome: null,
        narrative: narrative.narrative,
        sourceFile: pdfPath,
        extraction: { method, confidence },
      },
    };
  }

  const records = {};
  for (const [m, table] of Object.entries(tablesByMonth)) {
    records[m] = {
      month: m,
      occupancyPct: m === month ? narrative.occupancyPct : null,
      preLeasedPct: m === month ? narrative.preLeasedPct : null,
      income: table?.income ?? null,
      expense: table?.expense ?? null,
      noi: table?.noi ?? null,
      nonOperatingExpense: table?.nonOperatingExpense ?? null,
      netIncome: table?.netIncome ?? null,
      narrative: m === month ? narrative.narrative : null,
      sourceFile: pdfPath,
      extraction: { method, confidence },
    };
  }
  return records;
}

import { runGenericExtraction } from "./lib/run-extraction.mjs";
import { resolveArchiveRoot } from "./lib/archive-store.mjs";

export async function extractLegacyBatch(batchDir, manifest, config) {
  const entry = manifest.files.find((f) => f.docType === "monthly-update");
  if (!entry) return new Map();
  const pdfPath = path.join(batchDir, entry.fileName);
  const batchMonth = path.basename(batchDir);
  const records = await extractLegacyMonth(config, pdfPath, batchMonth);
  return new Map(Object.entries(records));
}

export async function runLegacyExtraction(config, rawDir, outputPath) {
  return runGenericExtraction(rawDir, outputPath, (batchDir, manifest) => extractLegacyBatch(batchDir, manifest, config));
}

import { readFile as readFileForConfig } from "node:fs/promises";

if (import.meta.url === `file://${process.argv[1]}`) {
  let config = null;
  try {
    const raw = await readFileForConfig("config.json", "utf8");
    config = JSON.parse(raw).vision_llm ?? null;
  } catch {
    console.warn("extract-legacy: no config.json / vision_llm block found; page-4 P&L table will be skipped.");
  }
  const result = await runLegacyExtraction(config, path.join(resolveArchiveRoot(), "legacy"), "data/legacy.json");
  console.log(`Processed months: ${result.monthsProcessed.join(", ") || "(none)"}`);
}
