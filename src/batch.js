/**
 * Maps values with bounded concurrency while preserving input order.
 * A failing mapper rejects the operation and prevents later batches from starting.
 */
export async function mapInBatches(items, batchSize, mapper) {
  if (!Array.isArray(items)) {
    throw new TypeError("mapInBatches: items must be an array");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("mapInBatches: batchSize must be a positive integer");
  }
  if (typeof mapper !== "function") {
    throw new TypeError("mapInBatches: mapper must be a function");
  }

  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const mapped = await Promise.all(
      batch.map((item, index) => mapper(item, offset + index)),
    );
    results.push(...mapped);
  }
  return results;
}
