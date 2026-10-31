import test from "node:test";
import assert from "node:assert/strict";
import { mapInBatches } from "../src/batch.js";

 test("mapInBatches maps every item and preserves input order", async () => {
  const result = await mapInBatches([1, 2, 3, 4, 5], 2, async (value) => value * 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test("mapInBatches never exceeds the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  await mapInBatches([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return value;
  });
  assert.equal(peak, 3);
});

test("mapInBatches passes each mapper the original index", async () => {
  const result = await mapInBatches(["a", "b", "c"], 2, async (value, index) => `${index}:${value}`);
  assert.deepEqual(result, ["0:a", "1:b", "2:c"]);
});

test("mapInBatches returns an empty result for an empty list", async () => {
  assert.deepEqual(await mapInBatches([], 4, async (value) => value), []);
});

test("mapInBatches rejects invalid inputs", async () => {
  await assert.rejects(mapInBatches(null, 2, async () => null), /items must be an array/);
  await assert.rejects(mapInBatches([], 0, async () => null), /batchSize must be a positive integer/);
  await assert.rejects(mapInBatches([], 1.5, async () => null), /batchSize must be a positive integer/);
  await assert.rejects(mapInBatches([], 1, null), /mapper must be a function/);
});

test("mapInBatches stops before later batches when a mapper fails", async () => {
  const started = [];
  await assert.rejects(
    mapInBatches([1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 2) throw new Error("mapper failed");
      return value;
    }),
    /mapper failed/,
  );
  assert.deepEqual(started.sort(), [1, 2]);
});
