import test from "node:test";
import assert from "node:assert/strict";
import { calculateAuraDiameter, calculateDistortExtent, getTokenGeometry, getAuraPosition, getEffectPosition, getTokenAttachmentOrigin, AURA_EXTRA_MARGIN_CELLS } from "../src/geometry.js";

test("aura includes configured radius plus a small edge allowance", () => {
  const diameter = calculateAuraDiameter({ width: 100, height: 80 }, 100, 3);
  assert.equal(diameter, 100 + 2 * 100 * (3 + AURA_EXTRA_MARGIN_CELLS));
});

test("non-square tokens use the longer dimension for a true circular aura", () => {
  assert.equal(calculateAuraDiameter({ width: 180, height: 90 }, 100, 2), 180 + 2 * 100 * 2.12);
});

test("invalid sizes and fractional radius are rejected", () => {
  assert.throws(() => calculateAuraDiameter({ width: 0, height: 80 }, 100, 3), /ширина/);
  assert.throws(() => calculateAuraDiameter({ width: 100, height: 80 }, 0, 3), /размер клетки/);
  assert.throws(() => calculateAuraDiameter({ width: 100, height: 80 }, 100, 2.5), /целым числом/);
});

test("token geometry returns Owlbear's visible world-space bounding-box centre", () => {
  const geometry = getTokenGeometry({
    min: { x: 10, y: 20 },
    max: { x: 210, y: 120 },
    center: { x: 110, y: 70 },
  }, 100);
  assert.deepEqual(geometry, { width: 200, height: 100, center: { x: 110, y: 70 } });
});

test("token centre is derived from the world-space bounding-box corners if center is omitted", () => {
  const geometry = getTokenGeometry({
    min: { x: 300, y: 180 },
    max: { x: 420, y: 300 },
  }, 100);
  assert.deepEqual(geometry.center, { x: 360, y: 240 });
});

test("missing bounds centre is not silently replaced with the token origin", () => {
  assert.throws(() => getTokenGeometry({ width: 100, height: 100 }, 100), /визуальный центр/);
});

test("token dimensions use explicit bounds dimensions when available", () => {
  const geometry = getTokenGeometry({ width: 180, height: 90, center: { x: 9999, y: 8888 } }, 100);
  assert.deepEqual(geometry, { width: 180, height: 90, center: { x: 9999, y: 8888 } });
});

test("missing bounds do not silently fall back to the grid cell size for position", () => {
  assert.throws(() => getTokenGeometry({}, 80), /визуальный центр/);
});

test("invalid bounds do not silently invent a world-space centre", () => {
  assert.throws(() => getTokenGeometry({ width: 0, height: -1 }, 70), /визуальный центр/);
});


test("normal circle and Effect use the same origin with different item-origin conventions", () => {
  const center = { x: 850, y: 620 };
  assert.deepEqual(getAuraPosition(center), center);
  assert.deepEqual(getEffectPosition(center, 400), { x: 650, y: 420 });
});

test("effect top-left offset is half of the exact Effect rectangle in both axes", () => {
  assert.deepEqual(getEffectPosition({ x: 1000, y: 800 }, 360, 240), { x: 820, y: 680 });
});

test("shared aura position supports explicit offsets without mutating the origin", () => {
  const origin = { x: 100, y: 200 };
  assert.deepEqual(getAuraPosition(origin, { x: 12, y: -8 }), { x: 112, y: 192 });
  assert.deepEqual(origin, { x: 100, y: 200 });
});

test("Effect position rejects non-positive rectangle dimensions", () => {
  assert.throws(() => getEffectPosition({ x: 0, y: 0 }, 0), /размер графического эффекта/);
  assert.throws(() => getEffectPosition({ x: 0, y: 0 }, 100, -5), /размер графического эффекта/);
});


test("Distort effect includes one extra grid cell beyond the token and requested radius", () => {
  assert.equal(calculateDistortExtent({ width: 100, height: 80 }, 100, 3), 100 + 2 * 100 * (3 + 1));
});


test("all aura types share the exact token attachment origin", () => {
  const token = { position: { x: 1234.5, y: -678.25 } };
  const origin = getTokenAttachmentOrigin(token);
  assert.deepEqual(origin, { x: 1234.5, y: -678.25 });
  assert.deepEqual(getAuraPosition(origin), { x: 1234.5, y: -678.25 });
  assert.deepEqual(getEffectPosition(origin, 600), { x: 934.5, y: -978.25 });
  assert.notEqual(origin, token.position);
});

test("invalid token attachment origins are rejected instead of inventing a position", () => {
  assert.throws(() => getTokenAttachmentOrigin({ position: null }), /точку привязки/);
  assert.throws(() => getTokenAttachmentOrigin({ position: { x: 10, y: Infinity } }), /точку привязки/);
});
