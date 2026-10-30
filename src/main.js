import OBR, { buildEffect, buildShape, isImage } from "@owlbear-rodeo/sdk";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings.js";
import { calculateAuraDiameter, calculateDistortExtent, getEffectPosition, getAuraPosition, getTokenAttachmentOrigin, getTokenGeometry } from "./geometry.js";
import { SHADERS } from "./shaders.js";
import "./style.css";

const EXTENSION_ID = "io.github.doctorlowcoding.token-auras";
const SETTINGS_KEY = `${EXTENSION_ID}/settings`;
const AURA_KEY = `${EXTENSION_ID}/aura`;
const LEGACY_AURA_KEYS = ["com.example.token-auras/aura"];
const MAX_SELECTED_TOKENS = 50;
const MAX_AURAS_PER_TOKEN = 24;
const MAX_ITEM_SIZE = 50000;
const RADIUS_MIN = 1;
const RADIUS_MAX = 20;
const EFFECT_LABELS = Object.freeze({
  spirits: "Духовные стражи",
  electric: "Электрический шар",
  lens: "Рыбий глаз",
  glow: "Свечение",
  shield: "Щит",
  touch: "Осязание",
  fog: "Туман",
});

function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Auras effect: missing #${id}`);
  return element;
}

const state = {
  sceneReady: false,
  busy: false,
  editing: null,
  records: [],
  selectionKey: null,
  selectionPollBusy: false,
  listRefreshGeneration: 0,
  listRefreshScheduled: false,
};

function setStatus(message, isError = false) {
  const element = $("status");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function syncActionState() {
  $("apply").disabled = !state.sceneReady || state.busy;
  $("save-edit").disabled = !state.sceneReady || state.busy;
  $("remove").disabled = !state.sceneReady || state.busy;
  $("refresh-auras").disabled = !state.sceneReady || state.busy;
  $("cancel-edit").disabled = !state.sceneReady || state.busy;
  document.querySelectorAll("[data-aura-action]").forEach((button) => {
    button.disabled = !state.sceneReady || state.busy;
  });
}

function setBusy(busy) {
  state.busy = Boolean(busy);
  syncActionState();
}

function setSceneReady(ready) {
  state.sceneReady = Boolean(ready);
  syncActionState();
  if (!state.sceneReady) renderAuraList([], "Нет активной сцены");
  if (!state.busy) setStatus(state.sceneReady ? "Готово" : "Нет активной сцены");
}

function getFormSettings() {
  const activeMode = document.querySelector("[data-mode].active")?.dataset.mode;
  return normalizeSettings({
    mode: activeMode,
    effect: $("effect").value,
    radius: $("radius").value,
    opacity: $("opacity").value,
    color: $("color").value,
    speed: $("speed").value,
    light: $("light").value,
  });
}

function updateModeVisibility(settings) {
  const effectMode = settings.mode === "effect";
  $("effect-wrap").classList.toggle("hidden", !effectMode);
  $("speed-wrap").classList.toggle("hidden", !effectMode);
  $("light-wrap").classList.toggle("hidden", !effectMode || settings.effect !== "fog");
}

function writeForm(settingsInput) {
  const settings = normalizeSettings(settingsInput);
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === settings.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateModeVisibility(settings);
  $("effect").value = settings.effect;
  $("radius").value = String(settings.radius);
  $("opacity").value = String(settings.opacity);
  $("opacity-value").value = `${settings.opacity}%`;
  $("color").value = settings.color;
  $("color-value").value = settings.color.toUpperCase();
  $("speed").value = String(settings.speed);
  $("light").value = String(settings.light);
}

function syncEditControls() {
  const editing = Boolean(state.editing);
  $("apply").classList.toggle("hidden", editing);
  $("save-edit").classList.toggle("hidden", !editing);
  $("cancel-edit").classList.toggle("hidden", !editing);
  $("apply").textContent = "Добавить ауру";
  $("save-edit").textContent = "Сохранить изменения";
}

function cancelEditing(resetForm = true) {
  state.editing = null;
  syncEditControls();
  if (resetForm) writeForm(DEFAULT_SETTINGS);
  renderAuraList(state.records);
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
        // Reuse the existing opacity control as the Distort warp strength.
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

function getAuraMetadata(item) {
  if (!item?.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) return null;
  for (const key of [AURA_KEY, ...LEGACY_AURA_KEYS]) {
    const value = item.metadata[key];
    if (value && typeof value.ownerTokenId === "string" && value.ownerTokenId.length > 0) {
      return value;
    }
  }
  return null;
}

function getAuraOwnerTokenId(item) {
  return getAuraMetadata(item)?.ownerTokenId ?? null;
}

function isOwnedAura(item, tokenIds) {
  const ownerTokenId = getAuraOwnerTokenId(item);
  return typeof ownerTokenId === "string" && tokenIds.has(ownerTokenId);
}

function auraMetadata(token, settings, kind, createdAt = Date.now(), extra = {}) {
  return {
    [AURA_KEY]: {
      ownerTokenId: token.id,
      revision: 27,
      kind,
      createdAt,
      settings: normalizeSettings(settings),
      ...extra,
    },
  };
}

async function deleteItemsSafely(api, ids) {
  if (!ids.length) return;
  try {
    await api.deleteItems(ids);
  } catch (error) {
    console.warn("Auras effect: cleanup failed", error);
  }
}

async function removeAuras(tokenIds) {
  const safeTokenIds = new Set(tokenIds.filter((id) => typeof id === "string" && id.length > 0));
  if (safeTokenIds.size === 0) return 0;

  const predicate = (item) => isOwnedAura(item, safeTokenIds);
  const [sceneItems, localItems] = await Promise.all([
    OBR.scene.items.getItems(predicate),
    OBR.scene.local.getItems(predicate),
  ]);
  const sceneIds = sceneItems.map((item) => item.id);
  const localIds = localItems.map((item) => item.id);
  const tasks = [];
  if (sceneIds.length) tasks.push(OBR.scene.items.deleteItems(sceneIds));
  if (localIds.length) tasks.push(OBR.scene.local.deleteItems(localIds));
  const results = await Promise.allSettled(tasks);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Не удалось удалить часть аур");
  }
  return sceneIds.length + localIds.length;
}

async function getAuraGeometry(token, settings, dpi) {
  const bounds = await OBR.scene.items.getItemBounds([token.id]);
  const tokenGeometry = getTokenGeometry(bounds, dpi);
  const diameter = calculateAuraDiameter(tokenGeometry, dpi, settings.radius);
  const distortExtent = calculateDistortExtent(tokenGeometry, dpi, settings.radius);
  if (!Number.isFinite(diameter) || diameter <= 0 || diameter > MAX_ITEM_SIZE) {
    throw new Error("Некорректный размер ауры");
  }
  if (!Number.isFinite(distortExtent) || distortExtent <= 0 || distortExtent > MAX_ITEM_SIZE) {
    throw new Error("Некорректный размер эффекта искажения");
  }
  return { ...tokenGeometry, diameter, distortExtent, dpi };
}

function createSceneAura(token, settingsInput, geometry, createdAt = Date.now()) {
  const settings = normalizeSettings(settingsInput);
  const origin = getTokenAttachmentOrigin(token);
  return buildShape()
    .name("Auras effect")
    .shapeType("CIRCLE")
    .width(geometry.diameter)
    .height(geometry.diameter)
    .position(getAuraPosition(origin))
    .attachedTo(token.id)
    .disableAttachmentBehavior(["ROTATION", "LOCKED", "COPY"])
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .metadata(auraMetadata(token, settings, "shape", createdAt))
    .fillColor(settings.color)
    .fillOpacity(settings.opacity / 100)
    .strokeColor(settings.color)
    .strokeOpacity(Math.min(1, settings.opacity / 100 + 0.25))
    .strokeWidth(3)
    .build();
}

function createLocalEffect(token, settingsInput, geometry, createdAt = Date.now()) {
  const settings = normalizeSettings(settingsInput);
  const isLens = settings.effect === "lens";
  const shader = buildShader(settings, geometry);
  // Match Auras and Emanations: every shader aura is one STANDALONE Effect
  // attached directly to its source token. POST_PROCESS only changes the
  // render layer; it does not require an intermediate attachment carrier.
  const extent = isLens ? geometry.distortExtent : geometry.diameter;
  const origin = getTokenAttachmentOrigin(token);

  const builder = buildEffect()
    .name(`Auras effect — ${EFFECT_LABELS[settings.effect]}`)
    .effectType("STANDALONE")
    .width(extent)
    .height(extent)
    // Every shader aura shares the exact same source-item attachment origin.
    // A STANDALONE Effect uses a top-left rectangle position, so the rectangle
    // is offset by half its extent while remaining centred on that origin.
    .position(getEffectPosition(origin, extent))
    .attachedTo(token.id)
    .disableAttachmentBehavior(["ROTATION", "LOCKED", "COPY"])
    .layer(isLens ? "POST_PROCESS" : "ATTACHMENT")
    .locked(true)
    .disableHit(true);

  // POST_PROCESS returns the sampled scene itself; do not force a sprite blend
  // mode over it. The regular particle shaders retain their existing blending.
  if (!isLens) builder.blendMode("SRC_OVER");

  return builder
    .sksl(shader.sksl)
    .uniforms(shader.uniforms)
    .metadata(auraMetadata(token, settings, "shader", createdAt))
    .build();
}

function createAuraEntry(token, settingsInput, geometry, createdAt = Date.now()) {
  const settings = normalizeSettings(settingsInput);
  if (settings.mode === "simple") {
    return { scope: "scene", item: createSceneAura(token, settings, geometry, createdAt) };
  }
  return { scope: "local", item: createLocalEffect(token, settings, geometry, createdAt) };
}

async function cleanupLegacyEffectObjects() {
  if (!await OBR.scene.isReady()) return;
  const [legacySceneItems, localItems] = await Promise.all([
    OBR.scene.items.getItems((item) => {
      const meta = item.metadata?.[AURA_KEY];
      return item.type === "SHAPE" && meta?.kind === "effect-carrier";
    }),
    OBR.scene.local.getItems((item) => {
      const meta = item.metadata?.[AURA_KEY];
      return item.type === "EFFECT" && typeof meta?.ownerTokenId === "string" && Number(meta.revision ?? 0) < 23
        || item.type === "SHAPE" && meta?.kind === "effect-carrier";
    }),
  ]);
  if (legacySceneItems.length) await OBR.scene.items.deleteItems(legacySceneItems.map((item) => item.id));
  if (localItems.length) await OBR.scene.local.deleteItems(localItems.map((item) => item.id));

  // A lens carrier and its shader live in the same local scene. This cleanup
  // only examines this player's local items and cannot affect another player.
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

async function readSelectedTokens() {
  const selection = await OBR.player.getSelection();
  const ids = [...new Set((Array.isArray(selection) ? selection : [])
    .filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return [];
  if (ids.length > MAX_SELECTED_TOKENS) throw new Error(`Выбери не более ${MAX_SELECTED_TOKENS} токенов`);
  const selectedIds = new Set(ids);
  const items = await OBR.scene.items.getItems((item) => selectedIds.has(item.id));
  return items.filter((item) => item.layer === "CHARACTER" && isImage(item));
}

async function getSelectedTokens() {
  const tokens = await readSelectedTokens();
  if (tokens.length === 0) throw new Error("Сначала выбери токен");
  return tokens;
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.all(items.slice(offset, offset + batchSize).map(mapper)));
  }
  return results;
}

function getAuraLabel(settings) {
  return settings.mode === "simple" ? "Обычная аура" : (EFFECT_LABELS[settings.effect] ?? "Эффект");
}

function toAuraRecord(item, scope, tokenNames) {
  const metadata = getAuraMetadata(item);
  if (!metadata || metadata.kind === "lens-carrier" || metadata.kind === "effect-carrier") return null;
  const settings = normalizeSettings(metadata.settings);
  return {
    id: item.id,
    scope,
    item,
    tokenId: metadata.ownerTokenId,
    tokenName: tokenNames.get(metadata.ownerTokenId) ?? "Токен",
    settings,
    createdAt: Number.isFinite(Number(metadata.createdAt)) ? Number(metadata.createdAt) : 0,
  };
}

async function readAuraRecords(tokens) {
  if (tokens.length === 0) return [];
  const tokenIds = new Set(tokens.map((token) => token.id));
  const tokenNames = new Map(tokens.map((token) => [token.id, token.name || "Токен"]));
  const predicate = (item) => isOwnedAura(item, tokenIds);
  const [sceneItems, localItems] = await Promise.all([
    OBR.scene.items.getItems(predicate),
    OBR.scene.local.getItems(predicate),
  ]);
  const records = [
    ...sceneItems.map((item) => toAuraRecord(item, "scene", tokenNames)),
    ...localItems.map((item) => toAuraRecord(item, "local", tokenNames)),
  ].filter(Boolean);
  records.sort((a, b) => a.tokenName.localeCompare(b.tokenName, "ru") || a.createdAt - b.createdAt);
  return records;
}

function makeAuraRow(record, showTokenName) {
  const row = document.createElement("div");
  row.className = "aura-row";
  if (state.editing?.id === record.id) row.classList.add("is-editing");

  const titleWrap = document.createElement("div");
  titleWrap.className = "aura-row-title-wrap";
  const title = document.createElement("span");
  title.className = "aura-row-title";
  title.textContent = getAuraLabel(record.settings);
  titleWrap.append(title);

  const subtitle = document.createElement("span");
  subtitle.className = "aura-row-subtitle";
  const info = `${record.settings.radius} кл. · ${record.settings.color.toUpperCase()} · ${record.settings.opacity}%`;
  subtitle.textContent = showTokenName ? `${record.tokenName} · ${info}` : info;
  titleWrap.append(subtitle);

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "aura-row-button";
  editButton.textContent = "Изменить";
  editButton.dataset.auraAction = "edit";
  editButton.addEventListener("click", () => beginEditing(record));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "aura-row-button delete";
  deleteButton.textContent = "×";
  deleteButton.title = "Удалить эту ауру";
  deleteButton.setAttribute("aria-label", `Удалить: ${getAuraLabel(record.settings)}`);
  deleteButton.dataset.auraAction = "delete";
  deleteButton.addEventListener("click", () => { void deleteAuraRecord(record); });

  row.append(titleWrap, editButton, deleteButton);
  return row;
}

function renderAuraList(records, emptyMessage = "На выбранных токенах пока нет аур") {
  const list = $("auras-list");
  list.replaceChildren();
  $("aura-count").value = String(records.length);
  $("aura-count").textContent = String(records.length);
  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aura-empty";
    empty.textContent = emptyMessage;
    list.append(empty);
  } else {
    const showTokenName = new Set(records.map((record) => record.tokenId)).size > 1;
    for (const record of records) list.append(makeAuraRow(record, showTokenName));
  }
  syncActionState();
}

async function refreshAuraList() {
  const generation = ++state.listRefreshGeneration;
  try {
    if (!state.sceneReady || !await OBR.scene.isReady()) {
      if (generation === state.listRefreshGeneration) {
        state.records = [];
        renderAuraList([], "Нет активной сцены");
      }
      return;
    }
    const tokens = await readSelectedTokens();
    if (generation !== state.listRefreshGeneration) return;
    if (tokens.length === 0) {
      state.records = [];
      renderAuraList([], "Выбери токен на сцене");
      return;
    }
    const records = await readAuraRecords(tokens);
    if (generation !== state.listRefreshGeneration) return;
    state.records = records;
    renderAuraList(records);
    if (state.editing && !records.some((record) => record.id === state.editing.id)) {
      state.editing = null;
      syncEditControls();
    }
  } catch (error) {
    if (generation !== state.listRefreshGeneration) return;
    console.warn("Auras effect: list refresh failed", error);
    renderAuraList([], "Не удалось загрузить список аур");
  }
}

function scheduleAuraListRefresh() {
  if (state.listRefreshScheduled) return;
  state.listRefreshScheduled = true;
  queueMicrotask(() => {
    state.listRefreshScheduled = false;
    void refreshAuraList();
  });
}

function beginEditing(record) {
  if (state.busy) return;
  state.editing = { id: record.id, scope: record.scope, tokenId: record.tokenId };
  writeForm(record.settings);
  syncEditControls();
  renderAuraList(state.records);
  setStatus("Редактирование ауры");
}

function flattenAuraParts(entries) {
  return entries.flatMap((entry) => Array.isArray(entry.parts) ? entry.parts : [entry]);
}

async function addPreparedEntries(entries) {
  const parts = flattenAuraParts(entries);
  const sceneItems = parts.filter((entry) => entry.scope === "scene").map((entry) => entry.item);
  const localItems = parts.filter((entry) => entry.scope === "local").map((entry) => entry.item);
  const sceneIds = sceneItems.map((item) => item.id);
  const localIds = localItems.map((item) => item.id);
  try {
    if (sceneItems.length) await OBR.scene.items.addItems(sceneItems);
    if (localItems.length) await OBR.scene.local.addItems(localItems);
  } catch (error) {
    await Promise.all([
      deleteItemsSafely(OBR.scene.items, sceneIds),
      deleteItemsSafely(OBR.scene.local, localIds),
    ]);
    throw error;
  }
  return { sceneIds, localIds, count: entries.length, parts };
}

async function saveDefaultSettings(settings) {
  try {
    await OBR.scene.setMetadata({ [SETTINGS_KEY]: settings });
  } catch (error) {
    console.warn("Auras effect: settings were not saved", error);
  }
}

async function applyAuras() {
  if (state.busy) return setStatus("Действие уже выполняется");
  setBusy(true);
  setStatus("Добавляю ауру…");
  try {
    if (!await OBR.scene.isReady()) throw new Error("Нет активной сцены");
    const settings = getFormSettings();
    const tokens = await getSelectedTokens();
    const tokenIds = new Set(tokens.map((token) => token.id));
    const existing = await readAuraRecords(tokens);
    const counts = new Map();
    for (const record of existing) counts.set(record.tokenId, (counts.get(record.tokenId) ?? 0) + 1);
    const atLimit = tokens.find((token) => (counts.get(token.id) ?? 0) >= MAX_AURAS_PER_TOKEN);
    if (atLimit) throw new Error(`На токене ${atLimit.name || ""} достигнут лимит аур: ${MAX_AURAS_PER_TOKEN}`);

    const dpi = Number(await OBR.scene.grid.getDpi());
    if (!Number.isFinite(dpi) || dpi <= 0 || dpi > MAX_ITEM_SIZE) throw new Error("Не удалось определить размер клетки");
    const entries = await mapInBatches(tokens, 5, async (token) => {
      const geometry = await getAuraGeometry(token, settings, dpi);
      return createAuraEntry(token, settings, geometry);
    });
    await addPreparedEntries(entries);
    await saveDefaultSettings(settings);
    state.selectionKey = [...tokenIds].sort().join("|");
    await refreshAuraList();
    setStatus(`Добавлено аур: ${entries.length}`);
  } catch (error) {
    console.error("Auras effect: add failed", error);
    setStatus(error instanceof Error ? error.message : "Не удалось добавить ауру", true);
  } finally {
    setBusy(false);
  }
}

async function findEditingRecord() {
  const editing = state.editing;
  if (!editing) throw new Error("Аура для редактирования не выбрана");
  const api = editing.scope === "scene" ? OBR.scene.items : OBR.scene.local;
  const items = await api.getItems([editing.id]);
  const item = items.find((candidate) => candidate.id === editing.id);
  if (!item || getAuraOwnerTokenId(item) !== editing.tokenId) throw new Error("Эта аура больше не существует");
  return { ...editing, item, api, metadata: getAuraMetadata(item) };
}

async function deleteAuraRecordParts(record) {
  const metadata = record.metadata ?? getAuraMetadata(record.item);
  const tasks = [record.api.deleteItems([record.id])];
  // Compatibility cleanup for lens auras created by 2.4.0–2.4.2, which used
  // an intermediate Shape carrier. New Distort auras no longer create one.
  if (typeof metadata?.carrierId === "string" && metadata.carrierId.length > 0) {
    const carrierId = metadata.carrierId;
    const [sceneItems, localItems] = await Promise.all([
      OBR.scene.items.getItems([carrierId]),
      OBR.scene.local.getItems([carrierId]),
    ]);
    if (sceneItems.some((item) => item.id === carrierId)) {
      tasks.push(OBR.scene.items.deleteItems([carrierId]));
    }
    if (localItems.some((item) => item.id === carrierId)) {
      tasks.push(OBR.scene.local.deleteItems([carrierId]));
    }
  }
  const results = await Promise.allSettled(tasks);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Не удалось полностью удалить ауру");
  }
}

async function saveAuraEdits() {
  if (state.busy) return setStatus("Действие уже выполняется");
  if (!state.editing) return;
  setBusy(true);
  setStatus("Сохраняю изменения…");
  let replacement = null;
  try {
    if (!await OBR.scene.isReady()) throw new Error("Нет активной сцены");
    const current = await findEditingRecord();
    const tokenItems = await OBR.scene.items.getItems([current.tokenId]);
    const token = tokenItems.find((item) => item.id === current.tokenId && item.layer === "CHARACTER" && isImage(item));
    if (!token) throw new Error("Исходный токен больше не найден");
    const settings = getFormSettings();
    const dpi = Number(await OBR.scene.grid.getDpi());
    if (!Number.isFinite(dpi) || dpi <= 0 || dpi > MAX_ITEM_SIZE) throw new Error("Не удалось определить размер клетки");
    const geometry = await getAuraGeometry(token, settings, dpi);
    replacement = createAuraEntry(token, settings, geometry, Date.now());
    await addPreparedEntries([replacement]);
    try {
      await deleteAuraRecordParts(current);
    } catch (deleteError) {
      const replacementParts = flattenAuraParts([replacement]);
      const sceneIds = replacementParts.filter((part) => part.scope === "scene").map((part) => part.item.id);
      const localIds = replacementParts.filter((part) => part.scope === "local").map((part) => part.item.id);
      await Promise.all([
        deleteItemsSafely(OBR.scene.items, sceneIds),
        deleteItemsSafely(OBR.scene.local, localIds),
      ]);
      replacement = null;
      throw deleteError;
    }

    state.editing = null;
    syncEditControls();
    await saveDefaultSettings(settings);
    await refreshAuraList();
    setStatus("Аура обновлена");
  } catch (error) {
    console.error("Auras effect: update failed", error);
    setStatus(error instanceof Error ? error.message : "Не удалось изменить ауру", true);
  } finally {
    setBusy(false);
  }
}

async function deleteAuraRecord(record) {
  if (state.busy) return setStatus("Действие уже выполняется");
  setBusy(true);
  try {
    const api = record.scope === "scene" ? OBR.scene.items : OBR.scene.local;
    const current = await api.getItems([record.id]);
    const currentItem = current.find((item) => item.id === record.id && getAuraOwnerTokenId(item) === record.tokenId);
    if (currentItem) {
      await deleteAuraRecordParts({ ...record, item: currentItem, metadata: getAuraMetadata(currentItem), api });
    }
    if (state.editing?.id === record.id) cancelEditing(false);
    await refreshAuraList();
    setStatus("Аура удалена");
  } catch (error) {
    console.error("Auras effect: delete failed", error);
    setStatus(error instanceof Error ? error.message : "Не удалось удалить ауру", true);
  } finally {
    setBusy(false);
  }
}

async function removeSelectedAuras() {
  if (state.busy) return setStatus("Действие уже выполняется");
  setBusy(true);
  setStatus("Удаляю ауры…");
  try {
    if (!await OBR.scene.isReady()) throw new Error("Нет активной сцены");
    const tokens = await getSelectedTokens();
    const tokenIds = tokens.map((token) => token.id);
    const count = await removeAuras(tokenIds);
    if (state.editing && tokenIds.includes(state.editing.tokenId)) {
      state.editing = null;
      syncEditControls();
    }
    await refreshAuraList();
    setStatus(count > 0 ? `Удалено аур: ${count}` : "Аур нет");
  } catch (error) {
    console.error("Auras effect: remove all failed", error);
    setStatus(error instanceof Error ? error.message : "Не удалось удалить ауры", true);
  } finally {
    setBusy(false);
  }
}

function setRadius(value) {
  const normalized = normalizeSettings({ radius: value }).radius;
  $("radius").value = String(normalized);
}

function changeRadius(delta) {
  const current = Number.parseInt($("radius").value, 10);
  const safeCurrent = Number.isFinite(current) ? current : DEFAULT_SETTINGS.radius;
  setRadius(Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, safeCurrent + delta)));
}

function bindControls() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-mode]").forEach((other) => {
        const active = other === button;
        other.classList.toggle("active", active);
        other.setAttribute("aria-pressed", String(active));
      });
      updateModeVisibility(getFormSettings());
    });
  });

  ["effect", "radius", "opacity", "color", "speed", "light"].forEach((id) => {
    const control = $(id);
    control.addEventListener("input", () => {
      if (id === "opacity") $("opacity-value").value = `${$("opacity").value}%`;
      if (id === "color") $("color-value").value = $("color").value.toUpperCase();
      if (id === "effect") updateModeVisibility(getFormSettings());
    });
    control.addEventListener("change", () => {
      if (id === "radius") setRadius($("radius").value);
      if (id === "opacity") $("opacity-value").value = `${$("opacity").value}%`;
      if (id === "color") $("color-value").value = $("color").value.toUpperCase();
      if (id === "effect") updateModeVisibility(getFormSettings());
    });
  });

  $("radius-down").addEventListener("click", () => changeRadius(-1));
  $("radius-up").addEventListener("click", () => changeRadius(1));
  $("apply").addEventListener("click", applyAuras);
  $("save-edit").addEventListener("click", saveAuraEdits);
  $("cancel-edit").addEventListener("click", () => cancelEditing(true));
  $("remove").addEventListener("click", removeSelectedAuras);
  $("refresh-auras").addEventListener("click", () => { void refreshAuraList(); });
}

async function pollSelection() {
  if (state.selectionPollBusy || !state.sceneReady) return;
  state.selectionPollBusy = true;
  try {
    const selection = await OBR.player.getSelection();
    const ids = [...new Set((Array.isArray(selection) ? selection : [])
      .filter((id) => typeof id === "string" && id.length > 0))].sort();
    const key = ids.join("|");
    if (key !== state.selectionKey) {
      state.selectionKey = key;
      await refreshAuraList();
    }
  } catch (error) {
    console.warn("Auras effect: selection refresh failed", error);
  } finally {
    state.selectionPollBusy = false;
  }
}

async function loadSceneSettings() {
  try {
    if (!await OBR.scene.isReady()) {
      setSceneReady(false);
      return;
    }
    setSceneReady(true);
    const metadata = await OBR.scene.getMetadata();
    if (!state.editing) writeForm(metadata?.[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
    await refreshAuraList();
    setStatus("Готово");
  } catch (error) {
    console.warn("Auras effect: could not load scene settings", error);
    setSceneReady(true);
    if (!state.editing) writeForm(DEFAULT_SETTINGS);
    await refreshAuraList();
    setStatus("Настройки не загружены; используются стандартные", true);
  }
}

function initializeOwlbear() {
  if (!OBR.isAvailable) {
    setSceneReady(false);
    setStatus("Открой Auras effect в Owlbear Rodeo", true);
    renderAuraList([], "Открой Auras effect в Owlbear Rodeo");
    return;
  }

  OBR.onReady(() => {
    OBR.scene.onReadyChange((ready) => {
      setSceneReady(Boolean(ready));
      state.selectionKey = null;
      if (ready) {
        void loadSceneSettings();
        void cleanupLegacyEffectObjects().catch((error) => console.warn("Auras effect: legacy cleanup failed", error));
      } else {
        state.editing = null;
        syncEditControls();
      }
    });

    OBR.scene.items.onChange(scheduleAuraListRefresh);
    OBR.scene.local.onChange(scheduleAuraListRefresh);
    void loadSceneSettings();
    void cleanupLegacyEffectObjects().catch((error) => console.warn("Auras effect: legacy cleanup failed", error));
    window.setInterval(() => { void pollSelection(); }, 850);
  });
}

bindControls();
writeForm(DEFAULT_SETTINGS);
syncEditControls();
setBusy(false);
initializeOwlbear();
