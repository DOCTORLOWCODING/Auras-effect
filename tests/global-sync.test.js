import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const peer = fs.readFileSync(path.join(root, "src/peer-renderer.js"), "utf8");
const backgroundHtml = fs.readFileSync(path.join(root, "background.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/manifest.json"), "utf8"));
const viteConfig = fs.readFileSync(path.join(root, "vite.config.js"), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("shader aura settings are stored as shared scene Shape definitions", () => {
  const definition = between(main, "function createEffectDefinition(", "function createAuraEntry(");
  assert.match(definition, /buildShape\(\)/);
  assert.match(definition, /auraMetadata\(token, settings, "effect-definition"/);
  assert.match(definition, /\.fillOpacity\(0\)/);
  assert.match(definition, /\.strokeOpacity\(0\)/);
  assert.match(definition, /\.attachedTo\(token\.id\)/);
});

test("selected shader modes create shared definitions; local GPU Effects are not written to the shared scene", () => {
  const factory = between(main, "function createAuraEntry(", "function isSharedEffectDefinition(");
  assert.match(factory, /scope: "scene", item: createEffectDefinition/);
  assert.doesNotMatch(factory, /scope: "local"/);
  assert.doesNotMatch(main, /buildEffect\(\)/);
});

test("a persistent background page is configured and included in the Vite build", () => {
  assert.equal(manifest.background_url, "https://doctorlowcoding.github.io/Auras-effect/background.html");
  assert.match(backgroundHtml, /src="\/src\/background\.js"/);
  assert.match(viteConfig, /background: resolve\(process\.cwd\(\), "background\.html"\)/);
});

test("persistent peer renderer is independent of the visible popover", () => {
  assert.match(fs.readFileSync(path.join(root, "src/background.js"), "utf8"), /peer-renderer/);
  assert.match(peer, /OBR\.onReady\(/);
  assert.match(peer, /OBR\.scene\.items\.onChange\(observeSceneSnapshot\)/);
  assert.doesNotMatch(main, /OBR\.broadcast\.onMessage/);
  assert.doesNotMatch(main, /OBR\.scene\.items\.onChange[\s\S]*?scheduleShaderSync/);
});

test("each client reconstructs local-only GPU Effects from shared scene definitions", () => {
  assert.match(peer, /OBR\.scene\.local\.getItems\(isLocalShaderRenderer\)/);
  assert.match(peer, /isSharedEffectDefinition/);
  assert.match(peer, /createLocalEffect\(/);
  assert.match(peer, /OBR\.scene\.local\.addItems\(addItems\)/);
  assert.match(peer, /OBR\.scene\.local\.deleteItems\(removeIds\)/);
  assert.match(peer, /sourceAuraId/);
});

test("local renderers are keyed to a shared aura id and not editable aura records", () => {
  const renderer = between(peer, "function createLocalEffect(", "async function mapInBatches(");
  assert.match(renderer, /metadataFor\(token, settings, "shader-renderer"/);
  assert.match(renderer, /sourceAuraId/);
  const recordMapper = between(main, "function toAuraRecord(", "async function readAuraRecords(");
  assert.match(recordMapper, /shader-renderer/);
});

test("movement-only scene snapshots are ignored by the background reconciler", () => {
  assert.match(peer, /OBR\.scene\.items\.onChange\(observeSceneSnapshot\)/);
  assert.match(peer, /getShaderSceneSignature/);
  assert.match(peer, /if \(signature === state\.observedSignature\) return/);
  assert.match(peer, /The attached Effect follows the source token natively/);
  assert.match(peer, /getTokenSizeKey/);
});

test("sync snapshots coalesce changes and avoid sequential per-aura geometry calls", () => {
  assert.match(peer, /scheduleReconcile\(items = null, forceFetch = false, delay = 35\)/);
  assert.match(peer, /MAX_PARALLEL_BOUNDS/);
  assert.match(peer, /mapInBatches\(tokenList, MAX_PARALLEL_BOUNDS/);
  assert.match(peer, /pendingSnapshot/);
  assert.match(peer, /state\.rerun/);
  const reconciliation = between(peer, "async function reconcile(", "function scheduleReconcile(");
  assert.doesNotMatch(reconciliation, /for \(const definition of definitions\) \{[\s\S]*?await OBR\.scene\.items\.getItemBounds/);
});

test("geometry is cached per token size and DPI, not per aura or token movement", () => {
  assert.match(peer, /const key = getTokenSizeKey\(token, dpi\)/);
  assert.match(peer, /cached\?\.key === key/);
  assert.match(peer, /state\.geometryCache\.set\(token\.id/);
  assert.match(peer, /state\.geometryCache\.clear\(\)/);
});

test("reconciliation batches renderer creation before stale renderer deletion", () => {
  const sync = between(peer, "async function reconcile(", "function scheduleReconcile(");
  assert.match(sync, /await OBR\.scene\.local\.addItems\(addItems\)/);
  assert.match(sync, /await OBR\.scene\.local\.deleteItems\(removeIds\)/);
  assert.ok(sync.indexOf("addItems(addItems)") < sync.indexOf("deleteItems(removeIds)"));
});

test("broadcast only requests an authoritative rescan; it never carries executable shader content", () => {
  const notifier = between(main, "async function notifyOtherClientsOfAuraChange(", "async function readSelectedTokens(");
  assert.match(notifier, /\{ type: "SYNC_AURAS" \}/);
  assert.doesNotMatch(notifier, /sksl|shaderCode|eval\(/i);
  const listener = between(peer, "OBR.broadcast.onMessage(", "void OBR.scene.isReady()");
  assert.match(listener, /event\?\.data\?\.type === "SYNC_AURAS"/);
  assert.match(listener, /scheduleReconcile\(null, true/);
  assert.doesNotMatch(listener, /event\.data\.shader|event\.data\.sksl/i);
});

test("legacy local-only shader auras migrate to durable shared definitions", () => {
  const migration = between(peer, "async function migrateLegacyLocalEffectsOnce(", "async function migrateLegacyLocalEffects()");
  assert.match(migration, /metadata\?\.kind === "shader"/);
  assert.match(migration, /createEffectDefinition\(/);
  assert.match(migration, /OBR\.scene\.items\.addItems\(definitions\)/);
  assert.match(migration, /OBR\.scene\.local\.deleteItems\(deleteIds\)/);
});

test("peer renderer bootstraps and retries after transient synchronization failures", () => {
  assert.match(peer, /function bootstrapScene\(/);
  assert.match(peer, /function handleSceneReady\(/);
  assert.match(peer, /RETRY_DELAY_MS/);
  assert.match(peer, /initial sync failed|bootstrap failed/);
});

test("scene snapshots are coalesced before expensive signature comparison", () => {
  const observer = between(peer, "function flushObservedSnapshot()", "async function migrateLegacyLocalEffectsOnce()");
  assert.match(observer, /state\.pendingObservedSnapshot = items/);
  assert.match(observer, /state\.observationTimer !== null/);
  assert.match(observer, /window\.setTimeout\(flushObservedSnapshot, 35\)/);
  assert.match(observer, /getSharedSignature\(items, dpi\)/);
});

test("broadcast wakeups force a local renderer diff even if the scene signature is unchanged", () => {
  assert.match(peer, /state\.forceApply = true/);
  assert.match(peer, /if \(state\.forceApply\) \{/);
  assert.match(peer, /state\.appliedSignature = null/);
  assert.match(peer, /scheduleReconcile\(null, true, 80\)/);
});

test("in-flight reconciliations are discarded when the active scene changes", () => {
  const reconcile = between(peer, "async function reconcile(", "function scheduleReconcile(");
  assert.match(reconcile, /const generation = state\.generation/);
  assert.ok((reconcile.match(/generation !== state\.generation/g) ?? []).length >= 3);
  assert.match(peer, /state\.generation \+= 1/);
});


test("the shared renderer capacity matches the maximum UI-supported aura count", () => {
  assert.match(main, /MAX_SELECTED_TOKENS = 50/);
  assert.match(main, /MAX_AURAS_PER_TOKEN = 24/);
  assert.match(peer, /MAX_SHARED_EFFECTS = 1200/);
});

test("successful reconciliation clears any pending retry timer", () => {
  const reconciliation = between(peer, "async function reconcile(", "function scheduleReconcile(");
  assert.match(reconciliation, /state\.appliedSignature = definitionsSignature/);
  assert.match(reconciliation, /window\.clearTimeout\(state\.retryTimer\)/);
  assert.match(reconciliation, /state\.retryTimer = null/);
});
