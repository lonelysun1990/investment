export function quarterFromMonth(month) {
  const [year, mo] = month.split("-");
  return `${year}-Q${Math.ceil(Number(mo) / 3)}`;
}

export function aggregateDistributionByQuarter(records) {
  const result = new Map();
  for (const [month, record] of Object.entries(records)) {
    if (record.distribution == null) continue;
    const q = quarterFromMonth(month);
    result.set(q, Math.round(((result.get(q) ?? 0) + record.distribution) * 100) / 100);
  }
  return result;
}
