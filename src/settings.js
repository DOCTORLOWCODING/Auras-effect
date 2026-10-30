export const DEFAULT_SETTINGS = Object.freeze({
  mode: "simple",
  effect: "spirits",
  radius: 3,
  opacity: 35,
  color: "#39a9ff",
  speed: 5,
  light: 55,
});

export const EFFECT_IDS = Object.freeze([
  "spirits",
  "electric",
  "lens",
  "glow",
  "shield",
  "touch",
  "fog",
]);

const HEX_COLOR = /^#[\da-f]{6}$/i;

function finiteNumber(value, fallback) {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSettings(candidate) {
  const source = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate
    : {};

  const radius = clamp(Math.round(finiteNumber(source.radius, DEFAULT_SETTINGS.radius)), 1, 20);
  const opacity = Math.round(clamp(finiteNumber(source.opacity, DEFAULT_SETTINGS.opacity), 5, 100));
  const speed = Math.round(clamp(finiteNumber(source.speed, DEFAULT_SETTINGS.speed), 1, 10));
  const light = Math.round(clamp(finiteNumber(source.light, DEFAULT_SETTINGS.light), 0, 100));
  const color = typeof source.color === "string" && HEX_COLOR.test(source.color)
    ? source.color.toLowerCase()
    : DEFAULT_SETTINGS.color;

  return {
    mode: source.mode === "effect" ? "effect" : "simple",
    effect: EFFECT_IDS.includes(source.effect) ? source.effect : DEFAULT_SETTINGS.effect,
    radius,
    opacity,
    color,
    speed,
    light,
  };
}
