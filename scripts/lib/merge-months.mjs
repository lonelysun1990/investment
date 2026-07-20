export function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "object") return Object.values(value).every(isBlank);
  return false;
}

export function mergeRecordFields(oldRecord, newRecord) {
  if (!oldRecord) return newRecord;
  const merged = { ...oldRecord };
  for (const [key, newValue] of Object.entries(newRecord)) {
    merged[key] = isBlank(newValue) ? oldRecord[key] : newValue;
  }
  return merged;
}

export function foldMonths(batchesOldToNew) {
  const result = new Map();
  for (const batch of batchesOldToNew) {
    for (const [month, record] of batch) {
      result.set(month, mergeRecordFields(result.get(month), record));
    }
  }
  return result;
}
