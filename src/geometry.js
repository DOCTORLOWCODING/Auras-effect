export const AURA_EXTRA_MARGIN_CELLS = 0.12;

/**
 * Use the source item's own attachment origin for every aura type.
 * Owlbear applies attached-item transforms relative to this point; the
 * visible image bounds are used only to calculate aura dimensions.
 */
export function getTokenAttachmentOrigin(token) {
  const x = Number(token?.position?.x);
  const y = Number(token?.position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("Не удалось определить точку привязки токена");
  }
  return { x, y };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Compute the position of an aura from one shared origin.
 *
 * Owlbear Shapes are positioned by their centre, while a STANDALONE Effect
 * occupies a rectangle whose position is its top-left corner. Both therefore
 * use the same origin, with an optional rectangle offset for Effects.
 * This mirrors the positioning model used by Auras and Emanations.
 */
export function getAuraPosition(origin, offset = { x: 0, y: 0 }, rectangleOffset = { x: 0, y: 0 }) {
  const x = Number(origin?.x);
  const y = Number(origin?.y);
  const ox = Number(offset?.x ?? 0);
  const oy = Number(offset?.y ?? 0);
  const rx = Number(rectangleOffset?.x ?? 0);
  const ry = Number(rectangleOffset?.y ?? 0);
  if (![x, y, ox, oy, rx, ry].every(Number.isFinite)) {
    throw new TypeError("Некорректная точка привязки ауры");
  }
  return { x: x + ox + rx, y: y + oy + ry };
}

/**
 * Convert the shared aura centre into the top-left position expected by a
 * STANDALONE Effect rectangle. The centre itself is never changed.
 */
export function getEffectPosition(origin, width, height = width) {
  const w = finitePositive(width);
  const h = finitePositive(height);
  if (!w || !h) throw new TypeError("Некорректный размер графического эффекта");
  return getAuraPosition(origin, undefined, { x: -w / 2, y: -h / 2 });
}

/**
 * Read visible token dimensions from Owlbear's world-space BoundingBox.
 * The returned centre is useful for diagnostics and measurements only: all
 * attached aura types use getTokenAttachmentOrigin(token), matching Owlbear's
 * item-origin positioning model and Auras and Emanations.
 */
export function getTokenGeometry(bounds, dpi) {
  const min = bounds?.min;
  const max = bounds?.max;
  const derivedWidth = Number(max?.x) - Number(min?.x);
  const derivedHeight = Number(max?.y) - Number(min?.y);

  const width = finitePositive(bounds?.width) ?? finitePositive(derivedWidth) ?? finitePositive(dpi);
  const height = finitePositive(bounds?.height) ?? finitePositive(derivedHeight) ?? finitePositive(dpi);

  if (!Number.isFinite(width) || width <= 0) {
    throw new TypeError("Не удалось определить ширину токена");
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new TypeError("Не удалось определить высоту токена");
  }

  // getItemBounds() returns world-space dimensions and centre. Keep the centre
  // for measurement/debugging; do not use it as the attached-item origin.
  const center = Number.isFinite(bounds?.center?.x) && Number.isFinite(bounds?.center?.y)
    ? { x: bounds.center.x, y: bounds.center.y }
    : Number.isFinite(min?.x) && Number.isFinite(min?.y)
      && Number.isFinite(max?.x) && Number.isFinite(max?.y)
      ? { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }
      : null;

  if (!center) {
    throw new TypeError("Не удалось определить визуальный центр токена по BoundingBox");
  }

  return { width, height, center };
}

/**
 * Returns a square diameter for a circular aura. Radius is measured from
 * the token's outer edge; a small 0.12-cell allowance prevents visual
 * overlap with grid lines due to line width and rasterization.
 */
export function calculateAuraDiameter(bounds, dpi, radius) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const gridSize = Number(dpi);
  const cells = Number(radius);

  if (!Number.isFinite(width) || width <= 0) throw new TypeError("Некорректная ширина токена");
  if (!Number.isFinite(height) || height <= 0) throw new TypeError("Некорректная высота токена");
  if (!Number.isFinite(gridSize) || gridSize <= 0) throw new TypeError("Некорректный размер клетки");
  if (!Number.isInteger(cells) || cells < 1 || cells > 20) throw new RangeError("Радиус должен быть целым числом от 1 до 20");

  const tokenDiameter = Math.max(width, height);
  return tokenDiameter + (2 * gridSize * (cells + AURA_EXTRA_MARGIN_CELLS));
}

/**
 * Post-process Distort needs one extra grid cell of overdraw around the
 * actual distortion radius. This mirrors Auras and Emanations' effect bounds.
 */
export function calculateDistortExtent(bounds, dpi, radius) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const gridSize = Number(dpi);
  const cells = Number(radius);

  if (!Number.isFinite(width) || width <= 0) throw new TypeError("Некорректная ширина токена");
  if (!Number.isFinite(height) || height <= 0) throw new TypeError("Некорректная высота токена");
  if (!Number.isFinite(gridSize) || gridSize <= 0) throw new TypeError("Некорректный размер клетки");
  if (!Number.isInteger(cells) || cells < 1 || cells > 20) throw new RangeError("Радиус должен быть целым числом от 1 до 20");

  const tokenDiameter = Math.max(width, height);
  return tokenDiameter + 2 * gridSize * (cells + 1);
}
