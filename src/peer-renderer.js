import OBR, { buildEffect, buildShape, isImage } from "@owlbear-rodeo/sdk";
import { normalizeSettings } from "./settings.js";
import {
  calculateAuraDiameter,
  calculateDistortExtent,
  getAuraPosition,
  getTokenAttachmentOrigin,
  getTokenGeometry,
} from "./geometry.js";
import { SHADERS } from "./shaders.js";
import { getShaderSceneSignature, getTokenSizeKey } from "./sync-state.js";

const EXTENSION_ID = "io.github.doctorlowcoding.token-auras";
const AURA_KEY = `${EXTENSION_ID}/aura`;
const LEGACY_AURA_KEYS = ["com.example.token-auras/aura"];
const MAX_ITEM_SIZE = 50000;
const MAX_SHARED_EFFECTS = 1200;
const MAX_PARALLEL_BOUNDS = 8;
const SYNC_CHANNEL = `${EXTENSION_ID}/sync`;
const RETRY_DELAY_MS = 650;
const EFFECT_LABELS = Object.freeze({
  spirits: "Духовные стражи",
  electric: "Электрический шар",
  lens: "Рыбий глаз",
  glow: "Свечение",
  shield: "Щит",
  touch: "Осязание",
  fog: "Туман",
});

const state = {
  ready: false,
  bootstrapping: false,
  generation: 0,
  dpi: null,
  observedSignature: null,
  appliedSignature: null,
  snapshot: null,
  pendingSnapshot: null,
  forceFetch: false,
  forceApply: false,
  running: false,
  rerun: false,
  timer: null,
  retryTimer: null,
  observationTimer: null,
  pendingObservedSnapshot: null,
  geometryCache: new Map(),
  migrationPromise: null,
};

function getAuraMetadata(item) {
  if (!item?.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) return null;
  for (const key of [AURA_KEY, ...LEGACY_AURA_KEYS]) {
    const metadata = item.metadata[key];
    if (metadata && typeof metadata.ownerTokenId === "string" && metadata.ownerTokenId.length > 0) {
      return metadata;
    }
  }
  return null;
}

function isSharedEffectDefinition(item) {
  return item?.type === "SHAPE" && getAuraMetadata(item)?.kind === "effect-definition";
}

function isLocalShaderRenderer(item) {
  const metadata = getAuraMetadata(item);
  return item?.type === "EFFECT" && metadata?.kind === "shader-renderer"
    && typeof metadata.sourceAuraId === "string" && metadata.sourceAuraId.length > 0;
}

function getOwnerTokenId(item) {
  return getAuraMetadata(item)?.ownerTokenId ?? null;
}

function metadataFor(token, settings, kind, createdAt = Date.now(), extra = {}) {
  return {
    [AURA_KEY]: {
      ownerTokenId: token.id,
      revision: 51,
      kind,
      createdAt,
      settings: normalizeSettings(settings),
      ...extra,
    },
  };
}

function validDpi(value) {
  const dpi = Number(value);
  return Number.isFinite(dpi) && dpi > 0 && dpi <= MAX_ITEM_SIZE ? dpi : null;
}

function buildAuraGeometry(tokenGeometry, settingsInput, dpi) {
  const settings = normalizeSettings(settingsInput);
  const diameter = calculateAuraDiameter(tokenGeometry, dpi, settings.radius);
  const distortExtent = calculateDistortExtent(tokenGeometry, dpi, settings.radius);
  if (!Number.isFinite(diameter) || diameter <= 0 || diameter > MAX_ITEM_SIZE) {
    throw new Error("Invalid aura diameter");
  }
  if (!Number.isFinite(distortExtent) || distortExtent <= 0 || distortExtent > MAX_ITEM_SIZE) {
    throw new Error("Invalid effect extent");
  }
  return { ...tokenGeometry, diameter, distortExtent, dpi };
}

function hexToVector(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    x: ((value >> 16) & 255) / 255,
    y: ((value >> 8) & 255) / 255,
    z: (value & 255) / 255,
  };
}

function buildShader(settingsInput, geometry) {
  const settings = normalizeSettings(settingsInput);
  if (settings.effect === "lens") {
    const itemRadiusUnits = Math.max(geometry.width, geometry.height) / (2 * geometry.dpi);
    return {
      sksl: SHADERS.lens,
      uniforms: [
        { name: "dpi", value: geometry.dpi },
        { name: "numUnits", value: settings.radius },
        { name: "itemRadiusUnits", value: itemRadiusUnits },
        { name: "warpFactor", value: (settings.opacity / 100) * (0.2 / 0.35) },
        { name: "speed", value: settings.speed / 5 },
      ],
    };
  }

  const uniforms = [
    { name: "auraColor", value: hexToVector(settings.color) },
    { name: "alpha", value: settings.opacity / 100 },
    { name: "speed", value: settings.speed / 5 },
  ];
  if (settings.effect === "fog") uniforms.push({ name: "light", value: settings.light / 100 });
  return { sksl: SHADERS[settings.effect], uniforms };
}

function createEffectDefinition(token, settingsInput, geometry, createdAt = Date.now(), extra = {}) {
  const settings = normalizeSettings({ ...settingsInput, mode: "effect" });
  const origin = getTokenAttachmentOrigin(token);
  return buildShape()
    .name("Auras effect shared definition")
    .shapeType("CIRCLE")
    .width(geometry.diameter)
    .height(geometry.diameter)
    .position(getAuraPosition(origin))
    .attachedTo(token.id)
    .disableAttachmentBehavior(["ROTATION", "LOCKED", "COPY"])
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .metadata(metadataFor(token, settings, "effect-definition", createdAt, extra))
    .fillColor("#000000")
    .fillOpacity(0)
    .strokeColor("#000000")
    .strokeOpacity(0)
    .strokeWidth(0)
    .build();
}

function getRenderSignature(settingsInput, geometry) {
  const settings = normalizeSettings({ ...settingsInput, mode: "effect" });
  return JSON.stringify({
    version: 2,
    settings,
    diameter: geometry.diameter,
    distortExtent: geometry.distortExtent,
    dpi: geometry.dpi,
  });
}

function createLocalEffect(token, settingsInput, geometry, sourceAuraId, signature, createdAt = Date.now()) {
  const settings = normalizeSettings({ ...settingsInput, mode: "effect" });
  const isLens = settings.effect === "lens";
  const shader = buildShader(settings, geometry);
  const extent = isLens ? geometry.distortExtent : geometry.diameter;
  const origin = getTokenAttachmentOrigin(token);
  const effectPosition = {
    x: origin.x - extent / 2,
    y: origin.y - extent / 2,
  };

  const builder = buildEffect()
    .name(`Auras effect — ${EFFECT_LABELS[settings.effect]}`)
    .effectType("STANDALONE")
    .width(extent)
    .height(extent)
    .position(effectPosition)
    .attachedTo(token.id)
    .disableAttachmentBehavior(["ROTATION", "LOCKED", "COPY"])
    .layer(isLens ? "POST_PROCESS" : "ATTACHMENT")
    .locked(true)
    .disableHit(true);

  if (!isLens) builder.blendMode("SRC_OVER");

  return builder
    .sksl(shader.sksl)
    .uniforms(shader.uniforms)
    .metadata(metadataFor(token, settings, "shader-renderer", createdAt, {
      sourceAuraId,
      renderSignature: signature,
    }))
    .build();
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.all(items.slice(index, index + batchSize).map(mapper)));
  }
  return results;
}

async function getCachedTokenGeometry(token, dpi) {
  const key = getTokenSizeKey(token, dpi);
  const cached = state.geometryCache.get(token.id);
  if (cached?.key === key) return cached.geometry;
  const bounds = await OBR.scene.items.getItemBounds([token.id]);
  const geometry = getTokenGeometry(bounds, dpi);
  state.geometryCache.set(token.id, { key, geometry });
  return geometry;
}

async function readSceneSnapshot() {
  const [items, dpiValue] = await Promise.all([
    OBR.scene.items.getItems(),
    OBR.scene.grid.getDpi(),
  ]);
  const dpi = validDpi(dpiValue);
  if (!dpi) throw new Error("Invalid scene DPI");
  state.dpi = dpi;
  state.snapshot = items;
  return items;
}

async function reconcile(itemsInput) {
  if (!state.ready || state.bootstrapping || !await OBR.scene.isReady()) return;
  const generation = state.generation;
  const items = Array.isArray(itemsInput) ? itemsInput : await readSceneSnapshot();
  const dpi = state.dpi ?? validDpi(await OBR.scene.grid.getDpi());
  if (!dpi) return;
  state.dpi = dpi;

  const definitions = items
    .filter(isSharedEffectDefinition)
    .sort((a, b) => {
      const left = Number(getAuraMetadata(a)?.createdAt) || 0;
      const right = Number(getAuraMetadata(b)?.createdAt) || 0;
      return left - right || a.id.localeCompare(b.id);
    })
    .slice(0, MAX_SHARED_EFFECTS);

  const tokensNeeded = new Set(definitions.map(getOwnerTokenId).filter(Boolean));
  const tokens = items.filter((item) => tokensNeeded.has(item.id) && item.layer === "CHARACTER" && isImage(item));
  const tokenById = new Map(tokens.map((token) => [token.id, token]));
  const definitionsSignature = getShaderSceneSignature(items, {
    getAuraMetadata,
    isSharedEffectDefinition,
    isImage,
    normalizeSettings,
  }, dpi);

  // Motion-only updates are intentionally filtered by getShaderSceneSignature.
  // The attached Effect follows the source token natively, so movement never
  // causes a delete/recreate cycle or a redundant bounds request.
  state.observedSignature = definitionsSignature;
  if (state.appliedSignature === definitionsSignature) return;

  const current = await OBR.scene.local.getItems(isLocalShaderRenderer);
  if (!state.ready || generation !== state.generation) return;
  const tokenGeometryById = new Map();
  const tokenList = [...tokensNeeded].map((id) => tokenById.get(id)).filter(Boolean);
  await mapInBatches(tokenList, MAX_PARALLEL_BOUNDS, async (token) => {
    const geometry = await getCachedTokenGeometry(token, dpi);
    tokenGeometryById.set(token.id, geometry);
  });
  if (!state.ready || generation !== state.generation) return;

  for (const cachedTokenId of state.geometryCache.keys()) {
    if (!tokensNeeded.has(cachedTokenId)) state.geometryCache.delete(cachedTokenId);
  }

  const desired = new Map();
  for (const definition of definitions) {
    const metadata = getAuraMetadata(definition);
    const token = tokenById.get(metadata?.ownerTokenId);
    const tokenGeometry = tokenGeometryById.get(metadata?.ownerTokenId);
    if (!token || !tokenGeometry) continue;
    const settings = normalizeSettings({ ...(metadata?.settings ?? {}), mode: "effect" });
    const geometry = buildAuraGeometry(tokenGeometry, settings, dpi);
    desired.set(definition.id, {
      token,
      settings,
      geometry,
      signature: getRenderSignature(settings, geometry),
      createdAt: Number(metadata.createdAt) || Date.now(),
    });
  }

  const currentBySource = new Map();
  for (const renderer of current) {
    const sourceAuraId = getAuraMetadata(renderer)?.sourceAuraId;
    if (typeof sourceAuraId !== "string" || !sourceAuraId) continue;
    const group = currentBySource.get(sourceAuraId) ?? [];
    group.push(renderer);
    currentBySource.set(sourceAuraId, group);
  }

  const addItems = [];
  const removeIds = [];
  for (const [sourceAuraId, renderers] of currentBySource) {
    const expected = desired.get(sourceAuraId);
    if (!expected) {
      removeIds.push(...renderers.map((renderer) => renderer.id));
      continue;
    }
    const matching = renderers.find((renderer) => getAuraMetadata(renderer)?.renderSignature === expected.signature);
    if (matching) {
      removeIds.push(...renderers.filter((renderer) => renderer.id !== matching.id).map((renderer) => renderer.id));
    } else {
      removeIds.push(...renderers.map((renderer) => renderer.id));
      addItems.push(createLocalEffect(
        expected.token,
        expected.settings,
        expected.geometry,
        sourceAuraId,
        expected.signature,
        expected.createdAt,
      ));
    }
  }

  for (const [sourceAuraId, expected] of desired) {
    if (currentBySource.has(sourceAuraId)) continue;
    addItems.push(createLocalEffect(
      expected.token,
      expected.settings,
      expected.geometry,
      sourceAuraId,
      expected.signature,
      expected.createdAt,
    ));
  }

  if (!state.ready || generation !== state.generation) return;

  // Add replacements before removing stale renderers to avoid a visible gap.
  if (addItems.length) await OBR.scene.local.addItems(addItems);
  if (removeIds.length) await OBR.scene.local.deleteItems(removeIds);
  state.appliedSignature = definitionsSignature;
  if (state.retryTimer !== null) {
    window.clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function scheduleReconcile(items = null, forceFetch = false, delay = 35) {
  if (Array.isArray(items)) state.pendingSnapshot = items;
  if (forceFetch) {
    state.forceFetch = true;
    state.forceApply = true;
    state.pendingSnapshot = null;
  }
  if (state.timer !== null) return;
  state.timer = window.setTimeout(() => {
    state.timer = null;
    const snapshot = state.forceFetch ? null : state.pendingSnapshot;
    state.pendingSnapshot = null;
    state.forceFetch = false;
    void enqueueReconcile(snapshot);
  }, delay);
}

async function enqueueReconcile(items = null) {
  if (state.running) {
    state.rerun = true;
    if (Array.isArray(items)) state.pendingSnapshot = items;
    return;
  }
  state.running = true;
  try {
    let snapshot = items;
    do {
      state.rerun = false;
      if (Array.isArray(state.pendingSnapshot)) {
        snapshot = state.pendingSnapshot;
        state.pendingSnapshot = null;
      }
      if (state.forceFetch) {
        state.forceFetch = false;
        snapshot = null;
      }
      if (state.forceApply) {
        state.forceApply = false;
        // A wake-up message may arrive after a renderer was lost locally while
        // the shared scene definition remained unchanged. Force a local diff.
        state.appliedSignature = null;
      }
      await reconcile(snapshot);
      snapshot = null;
    } while (state.rerun || Array.isArray(state.pendingSnapshot) || state.forceFetch || state.forceApply);
  } catch (error) {
    console.warn("Auras effect background renderer: sync failed", error);
    state.appliedSignature = null;
    if (state.retryTimer === null && state.ready) {
      state.retryTimer = window.setTimeout(() => {
        state.retryTimer = null;
        scheduleReconcile(null, true, 0);
      }, RETRY_DELAY_MS);
    }
  } finally {
    state.running = false;
    if (state.rerun || Array.isArray(state.pendingSnapshot) || state.forceFetch || state.forceApply) {
      scheduleReconcile(null, state.forceFetch || state.forceApply, 0);
    }
  }
}

function getSharedSignature(items, dpi) {
  return getShaderSceneSignature(items, {
    getAuraMetadata,
    isSharedEffectDefinition,
    isImage,
    normalizeSettings,
  }, dpi);
}

function flushObservedSnapshot() {
  state.observationTimer = null;
  const items = state.pendingObservedSnapshot;
  state.pendingObservedSnapshot = null;
  if (!Array.isArray(items) || !state.ready || state.bootstrapping) return;

  const dpi = state.dpi;
  if (!dpi) {
    scheduleReconcile(items, false, 0);
    return;
  }

  const signature = getSharedSignature(items, dpi);
  if (signature === state.observedSignature) return;
  state.observedSignature = signature;
  scheduleReconcile(items, false, 0);
}

function observeSceneSnapshot(items) {
  if (!Array.isArray(items)) return;
  state.snapshot = items;
  if (!state.ready || state.bootstrapping) return;

  // Owlbear sends a complete scene snapshot on every item change, including
  // each token movement. Coalesce rapid snapshots before serializing them;
  // this keeps movement events cheap and only reconciles real aura changes.
  state.pendingObservedSnapshot = items;
  if (state.observationTimer !== null) return;
  state.observationTimer = window.setTimeout(flushObservedSnapshot, 35);
}

async function migrateLegacyLocalEffectsOnce() {
  if (!await OBR.scene.isReady()) return false;
  const [localItems, sceneItems, dpiValue] = await Promise.all([
    OBR.scene.local.getItems((item) => {
      const metadata = getAuraMetadata(item);
      return item.type === "EFFECT" && metadata?.kind === "shader" && typeof metadata.ownerTokenId === "string";
    }),
    OBR.scene.items.getItems(),
    OBR.scene.grid.getDpi(),
  ]);
  if (!localItems.length) return false;
  const dpi = validDpi(dpiValue);
  if (!dpi) return false;

  const tokenById = new Map(sceneItems
    .filter((item) => item.layer === "CHARACTER" && isImage(item))
    .map((item) => [item.id, item]));
  const migratedIds = new Set(sceneItems
    .filter(isSharedEffectDefinition)
    .map((item) => getAuraMetadata(item)?.legacyLocalId)
    .filter((id) => typeof id === "string"));

  const definitions = [];
  const deleteIds = [];
  for (const localItem of localItems) {
    const metadata = getAuraMetadata(localItem);
    if (migratedIds.has(localItem.id)) {
      deleteIds.push(localItem.id);
      continue;
    }
    const token = tokenById.get(metadata.ownerTokenId);
    if (!token) continue;
    const bounds = await OBR.scene.items.getItemBounds([token.id]);
    const tokenGeometry = getTokenGeometry(bounds, dpi);
    const settings = normalizeSettings({ ...(metadata.settings ?? {}), mode: "effect" });
    const geometry = buildAuraGeometry(tokenGeometry, settings, dpi);
    definitions.push(createEffectDefinition(token, settings, geometry, Number(metadata.createdAt) || Date.now(), {
      legacyLocalId: localItem.id,
    }));
    deleteIds.push(localItem.id);
    migratedIds.add(localItem.id);
  }

  if (definitions.length) await OBR.scene.items.addItems(definitions);
  if (deleteIds.length) await OBR.scene.local.deleteItems(deleteIds);
  return definitions.length > 0;
}

async function migrateLegacyLocalEffects() {
  if (state.migrationPromise) return state.migrationPromise;
  state.migrationPromise = migrateLegacyLocalEffectsOnce();
  try {
    // bootstrapScene reads a fresh shared-scene snapshot immediately after
    // migration, so scheduling an intermediate reconcile here is redundant.
    return await state.migrationPromise;
  } finally {
    state.migrationPromise = null;
  }
}

async function cleanupLegacyEffectObjects() {
  if (!await OBR.scene.isReady()) return;
  const [legacySceneItems, localItems] = await Promise.all([
    OBR.scene.items.getItems((item) => {
      const metadata = item.metadata?.[AURA_KEY];
      return item.type === "SHAPE" && metadata?.kind === "effect-carrier";
    }),
    OBR.scene.local.getItems((item) => {
      const metadata = item.metadata?.[AURA_KEY];
      return (item.type === "EFFECT" && typeof metadata?.ownerTokenId === "string" && Number(metadata.revision ?? 0) < 23)
        || (item.type === "SHAPE" && metadata?.kind === "effect-carrier");
    }),
  ]);
  if (legacySceneItems.length) await OBR.scene.items.deleteItems(legacySceneItems.map((item) => item.id));
  if (localItems.length) await OBR.scene.local.deleteItems(localItems.map((item) => item.id));

  const currentLocal = await OBR.scene.local.getItems();
  const referencedCarrierIds = new Set(currentLocal
    .map((item) => getAuraMetadata(item)?.carrierId)
    .filter((id) => typeof id === "string" && id.length > 0));
  const orphanCarriers = currentLocal.filter((item) => {
    const metadata = getAuraMetadata(item);
    return metadata?.kind === "lens-carrier" && !referencedCarrierIds.has(item.id);
  });
  if (orphanCarriers.length) await OBR.scene.local.deleteItems(orphanCarriers.map((item) => item.id));
}

async function bootstrapScene() {
  if (state.bootstrapping) return;
  state.bootstrapping = true;
  let initialItems = null;
  try {
    await migrateLegacyLocalEffects();
    await cleanupLegacyEffectObjects();
    initialItems = await readSceneSnapshot();
    state.observedSignature = getSharedSignature(initialItems, state.dpi);
    state.appliedSignature = null;
  } catch (error) {
    console.warn("Auras effect background renderer: bootstrap failed", error);
  } finally {
    state.bootstrapping = false;
  }

  if (initialItems) {
    await enqueueReconcile(initialItems);
  } else {
    scheduleReconcile(null, true, RETRY_DELAY_MS);
  }
}

function handleSceneReady(ready) {
  const nextReady = Boolean(ready);
  if (nextReady === state.ready) return;
  state.ready = nextReady;
  state.generation += 1;
  if (!state.ready) {
    state.dpi = null;
    state.observedSignature = null;
    state.appliedSignature = null;
    state.snapshot = null;
    state.pendingSnapshot = null;
    state.geometryCache.clear();
    state.rerun = false;
    state.forceFetch = false;
    state.forceApply = false;
    if (state.timer !== null) window.clearTimeout(state.timer);
    if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
    if (state.observationTimer !== null) window.clearTimeout(state.observationTimer);
    state.timer = null;
    state.retryTimer = null;
    state.observationTimer = null;
    state.pendingObservedSnapshot = null;
    return;
  }
  void bootstrapScene();
}

function startPeerRenderer() {
  if (!OBR.isAvailable) return;
  OBR.onReady(() => {
    OBR.scene.onReadyChange(handleSceneReady);
    OBR.scene.items.onChange(observeSceneSnapshot);
    OBR.scene.grid.onChange((grid) => {
      const nextDpi = validDpi(grid?.dpi);
      if (nextDpi && nextDpi !== state.dpi) {
        state.dpi = nextDpi;
        state.geometryCache.clear();
        state.observedSignature = null;
        scheduleReconcile(state.snapshot, false, 0);
      }
    });
    OBR.broadcast.onMessage(SYNC_CHANNEL, (event) => {
      if (event?.data?.type === "SYNC_AURAS") {
        // The payload is intentionally ignored. Scene items remain authoritative.
        scheduleReconcile(null, true, 80);
      }
    });
    void OBR.scene.isReady().then(handleSceneReady).catch((error) => {
      console.warn("Auras effect background renderer: readiness check failed", error);
    });
  });
}

startPeerRenderer();
