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

const PNL_TABLE_PROMPT = `This image is a property-management "Trailing Profit and Loss" table with monthly columns. Extract the LATEST (rightmost, most recent) month's column only. Respond with ONLY a JSON object, no prose, matching exactly this shape:
{
  "income": { "rental": number, "other": number, "total": number },
  "expense": { "<exact category label as printed>": number, ..., "total": number },
  "noi": number,
  "debtService": number,
  "otherNonOperating": number,
  "capitalImprovements": number,
  "netIncome": number
}
Use negative numbers (not parentheses) for any value shown in parentheses in the image. Do not include currency symbols or commas in the numbers.`;

export async function extractPnlTable(config, pdfPath, month, opts = {}) {
  if (!config) {
    return { table: null, method: "unavailable", confidence: null };
  }
  const callVisionLlmImpl = opts.callVisionLlmImpl ?? callVisionLlm;

  const pngPath = path.join(tmpdir(), `legacy-pnl-${month}-${Date.now()}.png`);
  await renderPageToPng(pdfPath, PNL_TABLE_PAGE, pngPath);
  const imageBase64 = (await readFile(pngPath)).toString("base64");

  const responseText = await callVisionLlmImpl(config, imageBase64, PNL_TABLE_PROMPT);
  let table;
  try {
    table = JSON.parse(responseText);
  } catch {
    throw new Error(
      `extract-legacy: vision LLM response for ${month} was not valid JSON: ${responseText.slice(0, 200)}`
    );
  }

  const narrative = await extractNarrative(pdfPath);
  const noiMatches = Math.abs(Math.round(table.noi) - narrative.statedNoi) <= NOI_CROSS_CHECK_TOLERANCE;
  const revenueMatches =
    Math.abs(Math.round(table.income.total) - narrative.statedTotalRevenue) <= NOI_CROSS_CHECK_TOLERANCE;

  return {
    table,
    method: "vision_llm",
    confidence: noiMatches && revenueMatches ? "high" : "low",
  };
}

export async function extractLegacyMonth(config, pdfPath, month, opts = {}) {
  const narrative = await extractNarrative(pdfPath);
  const { table, method, confidence } = await extractPnlTable(config, pdfPath, month, opts);

  return {
    month,
    occupancyPct: narrative.occupancyPct,
    preLeasedPct: narrative.preLeasedPct,
    income: table?.income ?? null,
    expense: table?.expense ?? null,
    noi: table?.noi ?? null,
    debtService: table?.debtService ?? null,
    capitalImprovements: table?.capitalImprovements ?? null,
    netIncome: table?.netIncome ?? null,
    narrative: narrative.narrative,
    sourceFile: pdfPath,
    extraction: { method, confidence },
  };
}
