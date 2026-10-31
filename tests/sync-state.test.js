import test from "node:test";
import assert from "node:assert/strict";
import { getAuraRecordSignature, getShaderSceneSignature, getTokenSizeKey } from "../src/sync-state.js";
import { normalizeSettings } from "../src/settings.js";

const metadataKey = "io.github.doctorlowcoding.token-auras/aura";
const getAuraMetadata = (item) => item?.metadata?.[metadataKey] ?? null;
const isSharedEffectDefinition = (item) => item?.type === "SHAPE" && getAuraMetadata(item)?.kind === "effect-definition";
const isImage = (item) => item?.type === "IMAGE";
const helpers = { getAuraMetadata, isSharedEffectDefinition, isImage, normalizeSettings };

function fixture() {
  return [
    {
      id: "token-1",
      type: "IMAGE",
      layer: "CHARACTER",
      width: 100,
      height: 100,
      scale: { x: 1, y: 1 },
      position: { x: 100, y: 100 },
    },
    {
      id: "aura-1",
      type: "SHAPE",
      width: 720,
      height: 720,
      position: { x: -260, y: -260 },
      metadata: {
        [metadataKey]: {
          ownerTokenId: "token-1",
          kind: "effect-definition",
          createdAt: 1000,
          settings: { mode: "effect", effect: "spirits", radius: 3, color: "#39a9ff", opacity: 35 },
        },
      },
    },
  ];
}

test("token size cache key ignores world position but changes with scale, dimensions and DPI", () => {
  const token = fixture()[0];
  const initial = getTokenSizeKey(token, 100);
  token.position = { x: 10000, y: -5000 };
  assert.equal(getTokenSizeKey(token, 100), initial);
  token.scale.x = 1.5;
  assert.notEqual(getTokenSizeKey(token, 100), initial);
  assert.notEqual(getTokenSizeKey(token, 120), initial);
});

test("shader sync signature ignores token and attached-definition movement", () => {
  const items = fixture();
  const initial = getShaderSceneSignature(items, helpers, 100);
  items[0].position = { x: 500, y: 700 };
  items[1].position = { x: 140, y: 340 };
  assert.equal(getShaderSceneSignature(items, helpers, 100), initial);
});

test("shader sync signature changes when a shared aura is added, removed or edited", () => {
  const items = fixture();
  const initial = getShaderSceneSignature(items, helpers, 100);
  const added = [...items, { ...items[1], id: "aura-2" }];
  assert.notEqual(getShaderSceneSignature(added, helpers, 100), initial);
  assert.notEqual(getShaderSceneSignature(items.slice(0, 1), helpers, 100), initial);

  const edited = structuredClone(items);
  edited[1].metadata[metadataKey].settings.radius = 5;
  assert.notEqual(getShaderSceneSignature(edited, helpers, 100), initial);
});

test("shader sync signature changes after token resize without reacting to token movement", () => {
  const items = fixture();
  const initial = getShaderSceneSignature(items, helpers, 100);
  items[0].scale = { x: 2, y: 2 };
  assert.notEqual(getShaderSceneSignature(items, helpers, 100), initial);
});

test("aura list signature ignores movement but detects shared metadata changes", () => {
  const items = fixture();
  const initial = getAuraRecordSignature(items, getAuraMetadata, normalizeSettings);
  items[0].position = { x: 700, y: 700 };
  items[1].position = { x: -900, y: -900 };
  assert.equal(getAuraRecordSignature(items, getAuraMetadata, normalizeSettings), initial);

  items[1].metadata[metadataKey].settings.opacity = 80;
  assert.notEqual(getAuraRecordSignature(items, getAuraMetadata, normalizeSettings), initial);
});
