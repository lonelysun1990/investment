export function mergeDistributions(existingEntries, domEntries, totalByQuarter) {
  const byDate = new Map(existingEntries.map((e) => [e.date, e]));
  for (const { date, amount } of domEntries) {
    const existing = byDate.get(date);
    byDate.set(date, {
      date,
      myDistribution: amount,
      totalDistribution: totalByQuarter.has(date) ? totalByQuarter.get(date) : (existing?.totalDistribution ?? null),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
