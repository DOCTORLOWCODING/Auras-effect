import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_SETTINGS, EFFECT_IDS, normalizeSettings } from "../src/settings.js";

test("normalizes valid settings including fog light", () => {
  assert.deepEqual(normalizeSettings({
    mode: "effect", effect: "fog", radius: 5, opacity: 72,
    color: "#ABCDEF", speed: 8, light: 91,
  }), {
    mode: "effect", effect: "fog", radius: 5, opacity: 72,
    color: "#abcdef", speed: 8, light: 91,
  });
});

test("clamps untrusted metadata and rejects unsafe color and effect values", () => {
  assert.deepEqual(normalizeSettings({
    mode: "other", effect: "not-a-shader", radius: 999, opacity: -50,
    color: "url(javascript:alert(1))", speed: "Infinity", light: 999,
  }), { ...DEFAULT_SETTINGS, radius: 20, opacity: 5, light: 100 });
});

test("accepts exactly the supported effect identifiers", () => {
  assert.deepEqual([...EFFECT_IDS].sort(), ["electric", "glow", "lens", "shield", "spirits", "touch", "fog"].sort());
  for (const effect of EFFECT_IDS) assert.equal(normalizeSettings({ effect }).effect, effect);
  assert.equal(normalizeSettings({ effect: "<script>" }).effect, DEFAULT_SETTINGS.effect);
});

test("handles null, arrays and primitive metadata", () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings(["effect", 10]), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings("effect"), { ...DEFAULT_SETTINGS });
});

test("radius is always a whole number from 1 to 20", () => {
  assert.equal(normalizeSettings({ radius: 1.37 }).radius, 1);
  assert.equal(normalizeSettings({ radius: 1.5 }).radius, 2);
  assert.equal(normalizeSettings({ radius: 0 }).radius, 1);
  assert.equal(normalizeSettings({ radius: 99 }).radius, 20);
});

test("manifest version is 2.5.3 and keeps description fields absent", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "Auras effect");
  assert.equal(manifest.version, "2.5.3");
  assert.equal(manifest.action.title, "Auras effect");
  assert.equal(manifest.description, undefined);
  assert.equal(manifest.action.description, undefined);
  assert.equal(manifest.action.popover, "https://doctorlowcoding.github.io/Auras-effect/");
  assert.equal(manifest.action.height, 900);
});
