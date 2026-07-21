const DISAGREEMENT_THRESHOLD_PP = 1;

export function mergeOccupancySources(sourcesByPriority, sourceLabels) {
  const allMonths = new Set();
  for (const source of sourcesByPriority) {
    for (const month of source.keys()) allMonths.add(month);
  }

  const result = new Map();
  for (const month of allMonths) {
    const entries = sourcesByPriority
      .map((source, i) => ({ value: source.get(month), label: sourceLabels[i] }))
      .filter((e) => e.value !== undefined);
    if (entries.length === 0) continue;

    const chosen = entries[0];
    for (let i = 1; i < entries.length; i++) {
      if (Math.abs(entries[i].value - chosen.value) > DISAGREEMENT_THRESHOLD_PP) {
        console.warn(
          `mergeOccupancySources: ${month} occupancy disagreement -- using ${chosen.value}% from ${chosen.label}, but ${entries[i].label} reports ${entries[i].value}%`
        );
      }
    }
    result.set(month, chosen.value);
  }
  return result;
}
