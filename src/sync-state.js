/** Stable token geometry cache key. Movement is intentionally excluded. */
export function getTokenSizeKey(token, dpi) {
  const scale = token?.scale ?? {};
  return JSON.stringify({
    dpi,
    width: Number.isFinite(Number(token?.width)) ? Number(token.width) : null,
    height: Number.isFinite(Number(token?.height)) ? Number(token.height) : null,
    scaleX: Number.isFinite(Number(scale.x)) ? Number(scale.x) : 1,
    scaleY: Number.isFinite(Number(scale.y)) ? Number(scale.y) : 1,
  });
}

/**
 * Signature of user-managed aura records. Position is deliberately omitted,
 * so dragging a token does not cause a management-list network refresh.
 */
export function getAuraRecordSignature(items, getAuraMetadata, normalizeSettings) {
  const records = [];
  for (const item of items) {
    const metadata = getAuraMetadata(item);
    if (!metadata || ["lens-carrier", "effect-carrier", "shader-renderer"].includes(metadata.kind)) continue;
    records.push({
      id: item.id,
      ownerTokenId: metadata.ownerTokenId,
      kind: metadata.kind,
      createdAt: Number(metadata.createdAt) || 0,
      settings: normalizeSettings(metadata.settings),
    });
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(records);
}

/**
 * Signature of all inputs that can change a local shader renderer. Token
 * positions are intentionally ignored because the Effect is attached to the
 * shared token and Owlbear moves it natively. Size, scale, definitions and DPI
 * remain part of the signature so real geometry/settings changes reconcile.
 */
export function getShaderSceneSignature(items, helpers, dpi) {
  const { getAuraMetadata, isSharedEffectDefinition, isImage, normalizeSettings } = helpers;
  const definitions = items.filter(isSharedEffectDefinition);
  const tokenIds = new Set(definitions.map((item) => getAuraMetadata(item)?.ownerTokenId).filter(Boolean));
  const tokenLayouts = items
    .filter((item) => tokenIds.has(item.id) && item.layer === "CHARACTER" && isImage(item))
    .map((token) => ({ id: token.id, size: getTokenSizeKey(token, dpi) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const definitionLayouts = definitions.map((item) => {
    const metadata = getAuraMetadata(item);
    return {
      id: item.id,
      ownerTokenId: metadata.ownerTokenId,
      createdAt: Number(metadata.createdAt) || 0,
      settings: normalizeSettings({ ...(metadata.settings ?? {}), mode: "effect" }),
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ dpi, tokenLayouts, definitionLayouts });
}
