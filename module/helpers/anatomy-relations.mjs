/**
 * Typed relations and directional exposure for anatomy body parts.
 * @see docs/ANATOMY_SYSTEM.md
 */

/** @typedef {{ kind: string, target: string, chance?: number, direction?: string }} AnatomyRelation */

export const ANATOMY_RELATION_KINDS = Object.freeze(["adjacent", "behind", "parent"]);

/** Canonical facing / exposure axes (weighted, 0+). Плоскость боя: только четыре азимута. */
export const ANATOMY_EXPOSURE_DIRECTIONS = Object.freeze(["front", "back", "left", "right"]);

/**
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
export function sanitizeExposure(raw) {
  if (!raw || typeof raw !== "object") return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const dir of ANATOMY_EXPOSURE_DIRECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(raw, dir)) continue;
    const n = Number(raw[dir]);
    if (!Number.isFinite(n) || n < 0) continue;
    out[dir] = n;
  }
  // Legacy: top/bottom из старых данных — вливаем в front/back при чтении (не сохраняем обратно).
  if (Object.prototype.hasOwnProperty.call(raw, "top")) {
    const t = Number(raw.top);
    if (Number.isFinite(t) && t >= 0) out.front = (Number(out.front) || 0) + t;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "bottom")) {
    const b = Number(raw.bottom);
    if (Number.isFinite(b) && b >= 0) out.back = (Number(out.back) || 0) + b;
  }
  return out;
}

/**
 * Четыре направления для 2D-круга на сетке: перед / право / зад / лево.
 * @param {unknown} exposure
 * @returns {{ front: number, right: number, back: number, left: number }}
 */
export function getExposurePlanar4(exposure) {
  const ex = sanitizeExposure(exposure);
  return {
    front: Number(ex.front) || 0,
    right: Number(ex.right) || 0,
    back: Number(ex.back) || 0,
    left: Number(ex.left) || 0
  };
}

/**
 * @param {unknown} raw
 * @returns {AnatomyRelation | null}
 */
export function sanitizeRelation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind ?? "").trim();
  if (!ANATOMY_RELATION_KINDS.includes(kind)) return null;
  const target = String(raw.target ?? "").trim();
  if (!target) return null;
  /** @type {AnatomyRelation} */
  const out = { kind, target };
  if (kind === "behind") {
    const c = Number(raw.chance);
    if (Number.isFinite(c)) out.chance = Math.max(0, Math.min(100, c));
    const dir = String(raw.direction ?? "").trim().toLowerCase();
    if (dir && ANATOMY_EXPOSURE_DIRECTIONS.includes(dir)) out.direction = dir;
  }
  return out;
}

/**
 * @param {AnatomyRelation[]} relations
 * @returns {string}
 */
function _relationDedupeKey(r) {
  if (r.kind === "behind") {
    const c = r.chance;
    const d = r.direction ?? "";
    return `${r.kind}|${r.target}|${c === undefined ? "" : c}|${d}`;
  }
  return `${r.kind}|${r.target}`;
}

/**
 * @param {AnatomyRelation[]} relations
 * @returns {AnatomyRelation[]}
 */
export function dedupeRelations(relations) {
  const seen = new Set();
  const out = [];
  for (const r of relations) {
    if (!r?.target) continue;
    const k = _relationDedupeKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...r });
  }
  return out;
}

/**
 * Legacy string links -> adjacent relations (targets unchanged).
 * @param {string[]} linkStrings
 * @returns {AnatomyRelation[]}
 */
export function legacyLinksToAdjacentRelations(linkStrings) {
  if (!Array.isArray(linkStrings)) return [];
  const out = [];
  for (const to of linkStrings) {
    const t = String(to ?? "").trim();
    if (!t) continue;
    out.push({ kind: "adjacent", target: t });
  }
  return out;
}

/**
 * Merge legacy `links` into `relations` as adjacent edges when not already present.
 * @param {AnatomyRelation[]} relations
 * @param {string[]} legacyLinks
 * @returns {AnatomyRelation[]}
 */
export function mergeLegacyLinksIntoRelations(relations, legacyLinks) {
  const rels = Array.isArray(relations) ? relations.map(sanitizeRelation).filter(Boolean) : [];
  const adjacentTargets = new Set(rels.filter((r) => r.kind === "adjacent").map((r) => r.target));
  for (const t of legacyLinks || []) {
    const key = String(t ?? "").trim();
    if (!key || adjacentTargets.has(key)) continue;
    rels.push({ kind: "adjacent", target: key });
    adjacentTargets.add(key);
  }
  return dedupeRelations(rels);
}

/**
 * @param {AnatomyRelation[]} relations
 * @returns {string[]}
 */
export function deriveAdjacentLinksFromRelations(relations) {
  if (!Array.isArray(relations)) return [];
  const targets = relations.filter((r) => r.kind === "adjacent").map((r) => r.target).filter(Boolean);
  return [...new Set(targets)];
}

/**
 * Remap relation targets from anatomy JSON keys (or existing slotRefs) to slotRef keys.
 * @param {AnatomyRelation[]} relations
 * @param {Record<string, Object>} resultSlotRefMap
 * @param {Record<string, string>} rawKeyToSlotRef
 * @returns {AnatomyRelation[]}
 */
export function remapRelationTargets(relations, resultSlotRefMap, rawKeyToSlotRef) {
  const result = resultSlotRefMap && typeof resultSlotRefMap === "object" ? resultSlotRefMap : {};
  const rawMap = rawKeyToSlotRef && typeof rawKeyToSlotRef === "object" ? rawKeyToSlotRef : {};

  /** @type {Map<string, string[]>} */
  const slotsByTypeId = new Map();
  for (const slotRef of Object.keys(result)) {
    const part = result[slotRef];
    const tid = String(part?.id ?? "").trim();
    if (!tid) continue;
    if (!slotsByTypeId.has(tid)) slotsByTypeId.set(tid, []);
    slotsByTypeId.get(tid).push(slotRef);
  }

  return relations
    .map((r) => {
      const key = String(r.target ?? "").trim();
      if (!key) return null;
      if (result[key]) return { ...r, target: key };
      const mapped = rawMap[key];
      if (mapped && result[mapped]) return { ...r, target: mapped };
      const byType = slotsByTypeId.get(key);
      if (byType?.length === 1) return { ...r, target: byType[0] };
      return null;
    })
    .filter(Boolean);
}

/**
 * Enforce at most one `parent` per part (first wins).
 * @param {AnatomyRelation[]} relations
 * @returns {AnatomyRelation[]}
 */
export function enforceSingleParentRelation(relations) {
  let parentSeen = false;
  const out = [];
  for (const r of relations) {
    if (r.kind === "parent") {
      if (parentSeen) continue;
      parentSeen = true;
    }
    out.push(r);
  }
  return out;
}

/**
 * Runtime sync for actor body parts: ensure `relations` exists, migrate legacy `links`,
 * then set `links` to adjacent targets only (for editors / compat).
 * @param {Object} part
 */
export function ensureActorPartRelationsSynced(part) {
  if (!part || typeof part !== "object") return;

  let relations = Array.isArray(part.relations) ? part.relations.map(sanitizeRelation).filter(Boolean) : [];
  const legacyLinks = Array.isArray(part.links) ? part.links.map((t) => String(t ?? "").trim()).filter(Boolean) : [];

  if (relations.length === 0 && legacyLinks.length > 0) {
    relations = legacyLinksToAdjacentRelations(legacyLinks);
  } else if (legacyLinks.length > 0) {
    const adjacent = new Set(relations.filter((r) => r.kind === "adjacent").map((r) => r.target));
    for (const t of legacyLinks) {
      if (!adjacent.has(t)) {
        relations.push({ kind: "adjacent", target: t });
        adjacent.add(t);
      }
    }
  }

  relations = dedupeRelations(enforceSingleParentRelation(relations));
  part.relations = relations;
  part.links = deriveAdjacentLinksFromRelations(relations);
}

/**
 * Validate relations in a preset file: targets must be keys of bodyParts.
 * @param {Record<string, Object>} bodyParts
 * @param {AnatomyRelation[]} relations
 * @param {string} partKey - raw JSON key for logging
 * @returns {boolean}
 */
export function validateRelationsTargets(bodyParts, relations, partKey) {
  const keys = bodyParts && typeof bodyParts === "object" ? new Set(Object.keys(bodyParts)) : new Set();
  for (const r of relations || []) {
    const t = String(r?.target ?? "").trim();
    if (!t || !keys.has(t)) {
      console.error(`Anatomy | Part '${partKey}' has relation to unknown target '${t}'`);
      return false;
    }
  }
  return true;
}
