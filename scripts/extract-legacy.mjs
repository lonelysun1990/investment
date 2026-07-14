import { extractPageText } from "./lib/pdf-text.mjs";
import { parseMoney } from "./lib/money.mjs";

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
