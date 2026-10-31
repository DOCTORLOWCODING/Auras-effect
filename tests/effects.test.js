import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SHADERS } from "../src/shaders.js";
import { EFFECT_IDS } from "../src/settings.js";

const source = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const peerSource = fs.readFileSync(new URL("../src/peer-renderer.js", import.meta.url), "utf8");

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return text.slice(start, end);
}

test("all selectable effects have a dedicated SkSL shader", () => {
  assert.deepEqual(Object.keys(SHADERS).sort(), [...EFFECT_IDS].sort());
  for (const [id, shader] of Object.entries(SHADERS)) {
    assert.match(shader, /uniform vec2 size;/, `${id}: size uniform`);
    assert.match(shader, /uniform float time;/, `${id}: time uniform`);
    if (id !== "lens") assert.match(shader, /uniform vec3 auraColor;/, `${id}: color uniform`);
    assert.match(shader, /half4 main\(float2 (?:coord|fragCoordPx)\)/, `${id}: main function`);
  }
});

test("fish-eye matches the Auras and Emanations Distort pulse and matrix pipeline", () => {
  assert.match(SHADERS.lens, /uniform float dpi;/);
  assert.match(SHADERS.lens, /uniform float numUnits;/);
  assert.match(SHADERS.lens, /uniform float itemRadiusUnits;/);
  assert.match(SHADERS.lens, /uniform float warpFactor;/);
  assert.match(SHADERS.lens, /uniform mat3 model;/);
  assert.match(SHADERS.lens, /uniform mat3 view;/);
  assert.match(SHADERS.lens, /uniform shader scene;/);
  assert.match(SHADERS.lens, /sin\(PI \* pct\) \* sin\(2\.0 \* PI \* pct\)/);
  assert.match(SHADERS.lens, /sin\(time \* TIME_FACTOR \* max\(speed, 0\.15\)\) \* TIME_WARP_FACTOR/);
  assert.match(SHADERS.lens, /vec2 worldCoordPx = \(vec3\(fragCoordPx, 1\.0\) \* model\)\.xy/);
  assert.match(SHADERS.lens, /worldCoordPx \+= direction \* scaleOffset\(pct\)/);
  assert.match(SHADERS.lens, /vec2 viewCoordPx = \(vec3\(worldCoordPx, 1\.0\) \* view\)\.xy/);
  assert.match(SHADERS.lens, /return scene\.eval\(viewCoordPx\)/);
  assert.doesNotMatch(SHADERS.lens, /modelView|auraColor|blendAmount|half4 result = mix/);
});

test("fish-eye is one standalone post-process effect attached directly to the source token", () => {
  const effect = between(peerSource, "function createLocalEffect(", "async function getCachedTokenGeometry(");
  assert.match(effect, /effectType\("STANDALONE"\)/);
  assert.match(effect, /const origin = getTokenAttachmentOrigin\(token\)/);
  assert.match(effect, /\.position\(effectPosition\)/);
  assert.match(effect, /\.attachedTo\(token\.id\)/);
  assert.match(effect, /\.layer\(isLens \? "POST_PROCESS" : "ATTACHMENT"\)/);
  assert.match(effect, /if \(!isLens\) builder\.blendMode\("SRC_OVER"\)/);
  assert.doesNotMatch(effect, /geometry\.center|attachedTo\(attachment\.id\)/);
  assert.doesNotMatch(source, /function createLensCarrier\(/);
});

test("fish-eye uses the upstream extent formula and token attachment origin", () => {
  const geometry = between(peerSource, "function buildAuraGeometry(", "function hexToVector(");
  const effect = between(peerSource, "function createLocalEffect(", "async function getCachedTokenGeometry(");
  assert.match(geometry, /calculateDistortExtent\(tokenGeometry, dpi, settings\.radius\)/);
  assert.match(effect, /getTokenAttachmentOrigin\(token\)/);
  assert.match(effect, /effectPosition = \{/);
  assert.match(effect, /x: origin\.x - extent \/ 2/);
  assert.match(effect, /y: origin\.y - extent \/ 2/);
  assert.match(peerSource, /calculateDistortExtent/);
  assert.match(peerSource, /getTokenAttachmentOrigin/);
});

test("fish-eye returns only the sampled scene so its post-process bounds stay transparent", () => {
  assert.match(SHADERS.lens, /return scene\.eval\(viewCoordPx\)/);
  assert.doesNotMatch(SHADERS.lens, /return half4\(0\.0|auraColor|alpha \*|blendAmount|half4 result/);
});

test("fog shader receives a validated light uniform", () => {
  assert.match(SHADERS.fog, /uniform float light;/);
  assert.match(peerSource, /if \(settings\.effect === "fog"\) uniforms\.push\(\{ name: "light"/);
});

test("bubble shield and tactile waves have independent shader programs", () => {
  assert.match(SHADERS.shield, /float rim/);
  assert.match(SHADERS.shield, /float shine/);
  assert.match(SHADERS.touch, /float r1/);
  assert.match(SHADERS.touch, /float wave3/);
});

test("Shape and every shader Effect use the same token attachment origin", () => {
  const shape = between(source, "function createSceneAura(", "function createEffectDefinition(");
  const effect = between(peerSource, "function createLocalEffect(", "async function getCachedTokenGeometry(");
  assert.match(shape, /const origin = getTokenAttachmentOrigin\(token\)/);
  assert.match(shape, /\.position\(getAuraPosition\(origin\)\)/);
  assert.match(shape, /\.attachedTo\(token\.id\)/);
  assert.match(effect, /effectType\("STANDALONE"\)/);
  assert.match(effect, /const origin = getTokenAttachmentOrigin\(token\)/);
  assert.match(effect, /\.position\(effectPosition\)/);
  assert.doesNotMatch(effect, /geometry\.center|position\(getEffectPosition\(isLens/);
  assert.match(effect, /\.attachedTo\(token\.id\)/);
  assert.match(effect, /\.layer\(isLens \? "POST_PROCESS" : "ATTACHMENT"\)/);
});

test("applying an aura adds another item and does not replace existing auras", () => {
  const apply = between(source, "async function applyAuras()", "async function findEditingRecord()");
  assert.match(apply, /await addPreparedEntries\(entries\)/);
  assert.doesNotMatch(apply, /removeAuras\(/);
  assert.match(apply, /MAX_AURAS_PER_TOKEN/);
});

test("individual editing replaces only the selected record after adding its replacement", () => {
  const edit = between(source, "async function saveAuraEdits()", "async function deleteAuraRecord(");
  assert.match(edit, /findEditingRecord\(\)/);
  assert.match(edit, /await addPreparedEntries\(\[replacement\]\)/);
  assert.match(edit, /await deleteAuraRecordParts\(current\)/);
  assert.match(edit, /flattenAuraParts\(\[replacement\]\)/);
});

test("individual and bulk deletion are separate operations", () => {
  assert.match(source, /async function deleteAuraRecord\(record\)/);
  assert.match(source, /async function removeSelectedAuras\(\)/);
  assert.match(source, /OBR\.scene\.local\.getItems\(predicate\)/);
  assert.match(source, /OBR\.scene\.items\.getItems\(predicate\)/);
});

test("aura metadata uses a stable owner token and an individual item record", () => {
  assert.match(source, /ownerTokenId: token\.id/);
  assert.match(source, /settings: normalizeSettings\(settings\)/);
  assert.match(source, /function toAuraRecord\(item, scope, tokenNames\)/);
  assert.match(source, /record\.id/);
});


test("the popover never races the background renderer by deleting its local shader Effects", () => {
  const removal = between(source, "async function removeAuras(", "function buildAuraGeometry(");
  assert.match(removal, /getAuraMetadata\(item\)\?\.kind !== "shader-renderer"/);
  assert.doesNotMatch(source, /function deleteLocalRenderersForAura\(/);
  assert.doesNotMatch(source, /await deleteLocalRenderersForAura\(/);
});
