import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("shader aura settings are stored in a shared scene Shape definition", () => {
  const definition = between("function createEffectDefinition(", "function getEffectRenderSignature(");
  assert.match(definition, /buildShape\(\)/);
  assert.match(definition, /auraMetadata\(token, settings, \"effect-definition\"/);
  assert.match(definition, /\.fillOpacity\(0\)/);
  assert.match(definition, /\.strokeOpacity\(0\)/);
  assert.match(definition, /\.attachedTo\(token\.id\)/);
});

test("selected shader modes create shared definitions rather than local-only Effects", () => {
  const factory = between("function createAuraEntry(", "function isSharedEffectDefinition(");
  assert.match(factory, /scope: \"scene\", item: createEffectDefinition/);
  assert.doesNotMatch(factory, /scope: \"local\"/);
});

test("each client recreates a local GPU Effect from shared scene definitions", () => {
  const sync = between("async function syncLocalShaderEffectsOnce(", "async function syncLocalShaderEffects()");
  assert.match(sync, /OBR\.scene\.items\.getItems\(\)/);
  assert.match(sync, /isSharedEffectDefinition/);
  assert.match(sync, /createLocalEffect\(/);
  assert.match(sync, /OBR\.scene\.local\.addItems\(addItems\)/);
  assert.match(sync, /OBR\.scene\.local\.deleteItems\(removeIds\)/);
});

test("local renderers are keyed to a shared aura id and do not appear as editable aura records", () => {
  const renderer = between("function createLocalEffect(", "function createAuraEntry(");
  assert.match(renderer, /auraMetadata\(token, settings, \"shader-renderer\"/);
  assert.match(renderer, /sourceAuraId/);
  const recordMapper = between("function toAuraRecord(", "async function readAuraRecords(");
  assert.match(recordMapper, /shader-renderer/);
});

test("scene changes and peer sync messages refresh local shader effects", () => {
  assert.match(source, /OBR\.scene\.items\.onChange\(\(\) => \{/);
  assert.match(source, /scheduleShaderSync\(\)/);
  assert.match(source, /OBR\.broadcast\.onMessage\(SHADER_SYNC_CHANNEL/);
  assert.match(source, /destination: \"ALL\"/);
});

test("broadcast messages only request a resync; shader code is never accepted from peers", () => {
  const broadcast = between("async function notifyOtherClientsOfAuraChange(", "async function migrateLegacyLocalEffectsOnce(");
  assert.match(broadcast, /\{ type: \"SYNC_AURAS\" \}/);
  assert.doesNotMatch(broadcast, /sksl|shaderCode|eval\(/i);
  const listener = between("OBR\.broadcast\.onMessage", "void loadSceneSettings();");
  assert.match(listener, /event\?\.data\?\.type === \"SYNC_AURAS\"/);
  assert.match(listener, /scheduleShaderSync\(\)/);
});

test("legacy local-only shader auras are migrated into shared definitions", () => {
  const migration = between("async function migrateLegacyLocalEffectsOnce(", "async function migrateLegacyLocalEffects()");
  assert.match(migration, /metadata\?\.kind === \"shader\"/);
  assert.match(migration, /createEffectDefinition\(/);
  assert.match(migration, /OBR\.scene\.items\.addItems\(\[definition\]\)/);
  assert.match(migration, /OBR\.scene\.local\.deleteItems\(\[localItem\.id\]\)/);
});
