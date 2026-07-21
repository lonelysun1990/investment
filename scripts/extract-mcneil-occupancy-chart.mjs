import { readFile } from "node:fs/promises";
import { callVisionLlm } from "./lib/vision-llm.mjs";

const MONTH_ABBR = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const OCCUPANCY_CHART_PROMPT = `This image is a chart with month labels on the x-axis (3-letter abbreviations, no year, oldest on the left, most recent on the right) and two data series: a bar chart "Monthly Revenue" (left y-axis, dollars) and a line chart "Occupancy %" (right y-axis, percentage). Read ONLY the Occupancy % line's value at each labeled month. Respond with ONLY a JSON object, no prose or code fences, matching exactly this shape:
{
  "months": [
    { "label": "<3-letter month abbreviation as printed, e.g. Jul>", "occupancyPct": number }
  ]
}
List every labeled month from left to right, in the order they appear on the chart. Do not include the $ revenue values or bar heights, only the Occupancy % line's value.`;

export function resolveTrailingMonths(labels, anchorMonth) {
  const [anchorYear, anchorMonthNum] = anchorMonth.split("-").map(Number);
  const n = labels.length;
  return labels.map((label, i) => {
    const monthNum = MONTH_ABBR[label];
    if (!monthNum) {
      throw new Error(`extract-mcneil-occupancy-chart: unrecognized month abbreviation "${label}"`);
    }
    const offset = n - 1 - i;
    const totalMonths = anchorYear * 12 + (anchorMonthNum - 1) - offset;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    if (month !== monthNum) {
      throw new Error(
        `extract-mcneil-occupancy-chart: chart labels are not a consecutive trailing run ending at ${anchorMonth} -- label "${label}" at position ${i} does not land on its own month once anchored`
      );
    }
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

export async function extractOccupancyChart(config, imagePath, anchorMonth, opts = {}) {
  if (!config) return null;
  const callVisionLlmImpl = opts.callVisionLlmImpl ?? callVisionLlm;

  const imageBase64 = (await readFile(imagePath)).toString("base64");
  let responseText = await callVisionLlmImpl(config, imageBase64, OCCUPANCY_CHART_PROMPT);
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `extract-mcneil-occupancy-chart: vision LLM response was not valid JSON: ${responseText.slice(0, 200)}`
    );
  }

  const months = result.months ?? [];
  const labels = months.map((m) => m.label);
  const resolvedMonths = resolveTrailingMonths(labels, anchorMonth);

  const occupancyByMonth = {};
  months.forEach((m, i) => {
    occupancyByMonth[resolvedMonths[i]] = m.occupancyPct;
  });
  return occupancyByMonth;
}
