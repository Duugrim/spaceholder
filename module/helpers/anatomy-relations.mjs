/**
 * Typed relations and directional exposure for anatomy body parts.
 * @see docs/code/reference/ANATOMY_SYSTEM.md
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

/* ================================================================== *
 *  Part tree (`parent` relations)                                      *
 * ================================================================== */

/**
 * Slot key of the part's parent (first `parent` relation), or `null` for a root / unknown part.
 * @param {Record<string, Object>} bodyParts
 * @param {string} slotRef
 * @returns {string|null}
 */
export function parentOf(bodyParts, slotRef) {
  const rels = bodyParts?.[slotRef]?.relations;
  if (!Array.isArray(rels)) return null;
  const rel = rels.find((r) => r && r.kind === "parent" && r.target);
  const target = rel ? String(rel.target).trim() : "";
  return target && bodyParts[target] ? target : null;
}

/**
 * Direct children of a part (parts whose `parent` points at it), in key order.
 * @param {Record<string, Object>} bodyParts
 * @param {string} slotRef
 * @returns {string[]}
 */
export function childrenOf(bodyParts, slotRef) {
  return Object.keys(bodyParts ?? {}).filter((key) => parentOf(bodyParts, key) === slotRef);
}

/**
 * Everything below a part in the tree (children, grandchildren…), breadth first, without the part itself.
 * Safe against cycles in broken data.
 * @param {Record<string, Object>} bodyParts
 * @param {string} slotRef
 * @returns {string[]}
 */
export function descendantsOf(bodyParts, slotRef) {
  const out = [];
  const seen = new Set([slotRef]);
  const queue = [slotRef];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenOf(bodyParts, cur)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Parts without a parent: root candidates (a valid anatomy has exactly one).
 * @param {Record<string, Object>} bodyParts
 * @returns {string[]}
 */
export function parentlessParts(bodyParts) {
  return Object.keys(bodyParts ?? {}).filter((key) => !parentOf(bodyParts, key));
}

/**
 * The root slot of an anatomy: `rootRef` when it names an existing part, otherwise the first part
 * without a parent (old actors / presets saved before `root` existed). `null` when there are no parts.
 * @param {Record<string, Object>} bodyParts
 * @param {string} [rootRef]
 * @returns {string|null}
 */
export function resolveRootRef(bodyParts, rootRef) {
  const parts = bodyParts && typeof bodyParts === "object" ? bodyParts : {};
  const wanted = String(rootRef ?? "").trim();
  if (wanted && parts[wanted]) return wanted;
  return parentlessParts(parts)[0] ?? null;
}

/**
 * Check that the `parent` relations form one tree hanging from `root`.
 * @param {Record<string, Object>} bodyParts
 * @param {string} root
 * @returns {{ ok: boolean, errors: Array<{ code: string, part?: string }> }}
 */
export function validatePartTree(bodyParts, root) {
  const parts = bodyParts && typeof bodyParts === "object" ? bodyParts : {};
  const errors = [];
  if (!Object.keys(parts).length) return { ok: true, errors };
  const rootKey = String(root ?? "").trim();
  if (!rootKey || !parts[rootKey]) {
    errors.push({ code: "root-missing", part: rootKey || undefined });
    return { ok: false, errors };
  }
  if (parentOf(parts, rootKey)) errors.push({ code: "root-has-parent", part: rootKey });
  for (const key of Object.keys(parts)) {
    const seen = new Set([key]);
    let cur = key;
    let reachesRoot = key === rootKey;
    while (!reachesRoot) {
      const next = parentOf(parts, cur);
      if (!next) break;
      if (seen.has(next)) {
        errors.push({ code: "cycle", part: key });
        break;
      }
      seen.add(next);
      cur = next;
      reachesRoot = cur === rootKey;
    }
    if (!reachesRoot && !errors.some((e) => e.code === "cycle" && e.part === key)) {
      errors.push({ code: "not-under-root", part: key });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Parent changes needed to make `newRoot` the root without breaking the tree: the chain from `newRoot`
 * up to the old root is turned around, everything else keeps its parent.
 * @param {Record<string, Object>} bodyParts
 * @param {string} newRoot
 * @returns {Record<string, string|null>} new parent per part that changes (`null` = no parent); `{}` if `newRoot` is unknown
 */
export function rerootParents(bodyParts, newRoot) {
  if (!bodyParts?.[newRoot]) return {};
  const path = [newRoot];
  const seen = new Set(path);
  let cur = newRoot;
  for (;;) {
    const next = parentOf(bodyParts, cur);
    if (!next || seen.has(next)) break;
    path.push(next);
    seen.add(next);
    cur = next;
  }
  const changes = { [newRoot]: null };
  for (let i = 1; i < path.length; i += 1) changes[path[i]] = path[i - 1];
  return changes;
}

/**
 * Lost parts: a destroyed part is lost, and so is everything below it in the `parent` tree. Destroyed is the
 * part's own `destroyed` flag when it has one (body-state: below its reserve), else its HP is gone (`currentHp` ≤ 0
 * while it has HP to lose). Pure: expects `currentHp` / `effectiveMaxHp` (or `maxHp`) already derived on each part.
 * @param {Record<string, Object>} bodyParts
 * @returns {Record<string, string>} lost slot → the nearest ancestor (or the part itself) whose HP ran out
 */
export function computeLostParts(bodyParts) {
  const parts = bodyParts && typeof bodyParts === "object" ? bodyParts : {};
  const destroyed = (key) => {
    const part = parts[key];
    if (typeof part?.destroyed === "boolean") return part.destroyed;
    const max = Number(part?.effectiveMaxHp ?? part?.maxHp) || 0;
    return max > 0 && (Number(part?.currentHp ?? max) || 0) <= 0;
  };
  /** @type {Record<string, string>} */
  const lost = {};
  for (const key of Object.keys(parts)) {
    if (destroyed(key)) {
      lost[key] = key;
      continue;
    }
    const seen = new Set([key]);
    let cur = parentOf(parts, key);
    while (cur && !seen.has(cur)) {
      if (destroyed(cur)) {
        lost[key] = cur;
        break;
      }
      seen.add(cur);
      cur = parentOf(parts, cur);
    }
  }
  return lost;
}
