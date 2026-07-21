const MONTH_ABBR = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

export function resolveMonthAbbr(abbr, anchorMonth) {
  const monthNum = MONTH_ABBR[abbr];
  if (!monthNum) {
    throw new Error(`extract-mcneil-occupancy-narrative: unrecognized month abbreviation "${abbr}"`);
  }
  const [anchorYear, anchorMonthNum] = anchorMonth.split("-").map(Number);
  const year = monthNum > anchorMonthNum ? anchorYear - 1 : anchorYear;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

const DIRECT_STATEMENT_PATTERN = /Occupancy:\s*([\d.]+)%\s*\((\w+)\)\s*vs\.\s*([\d.]+)%\s*\((\w+)\)/i;

export function extractDirectStatement(narrativeText, anchorMonth) {
  const match = narrativeText.match(DIRECT_STATEMENT_PATTERN);
  if (!match) return null;
  const [, pctA, abbrA, pctB, abbrB] = match;
  return {
    [resolveMonthAbbr(abbrA, anchorMonth)]: Number(pctA),
    [resolveMonthAbbr(abbrB, anchorMonth)]: Number(pctB),
  };
}

const VACANT_UNIT_PATTERN = /(\d+)\s+vacant units?/i;

export function extractVacantUnitNarrative(narrativeText, anchorMonth, totalUnits) {
  const match = narrativeText.match(VACANT_UNIT_PATTERN);
  if (!match) return null;
  const vacant = Number(match[1]);
  const occupancyPct = Math.round(((totalUnits - vacant) / totalUnits) * 1000) / 10;
  return { [anchorMonth]: occupancyPct };
}
