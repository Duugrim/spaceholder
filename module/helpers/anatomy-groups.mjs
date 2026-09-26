/**
 * Anatomy groups, faces, inners, heightFrac — sanitizers and actor queries.
 * Groups live on the preset / `system.anatomy.groups`; ability is HP ratio.
 */

export const ANATOMY_GROUP_TYPES = Object.freeze([
  'manipulation',
  'movement',
  'sensory',
  'critical',
]);

export const ANATOMY_FACES = Object.freeze(['front', 'back']);

export const DEFAULT_ANATOMY_HEIGHT_M = 1.75;
export const DEFAULT_PART_MATERIAL = 'skin';

/** Legacy coverage / part ids → canonical humanoid slot + face. */
export const LEGACY_HUMANOID_PART_REMAP = Object.freeze({
  chest: { partId: 'upperTorso', face: 'front' },
  back: { partId: 'upperTorso', face: 'back' },
  abdomen: { partId: 'lowerTorso', face: 'front' },
  groin: { partId: 'lowerTorso', face: 'front' },
});

const LEGACY_INJURY_CATEGORY = Object.freeze({
  biological: 'biological',
  bionic: 'bionic',
  flesh: 'biological',
  armor: 'biological',
  other: 'biological',
  cybernetic: 'bionic',
});

function _clamp01(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function _id(raw) {
  return String(raw ?? '').trim();
}

/**
 * @param {unknown} raw
 * @returns {string[]} unique faces, at least `['front']`
 */
export function sanitizeFaces(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const face = String(item ?? '').toLowerCase().trim();
    if (!ANATOMY_FACES.includes(face) || seen.has(face)) continue;
    seen.add(face);
    out.push(face);
  }
  return out.length ? out : ['front'];
}

/**
 * Incoming hit face for a part: prefer `direction` if the part has it,
 * otherwise the first declared face (limbs are typically just `front`).
 * @param {object} part
 * @param {string} direction
 * @returns {string}
 */
export function resolveIncomingFace(part, direction) {
  const faces = sanitizeFaces(part?.faces);
  const dir = String(direction ?? 'front').toLowerCase().trim();
  if (faces.includes(dir)) return dir;
  return faces[0] || 'front';
}

/**
 * Opposite face if the part actually has one (torso vest); otherwise null.
 * @param {object} part
 * @param {string} incomingFace
 * @returns {string|null}
 */
export function resolveOppositeFace(part, incomingFace) {
  const faces = sanitizeFaces(part?.faces);
  const incoming = String(incomingFace ?? 'front').toLowerCase().trim();
  const opp = incoming === 'back' ? 'front' : 'back';
  return faces.includes(opp) ? opp : null;
}

/**
 * @param {unknown} raw
 * @returns {Array<{id:string, name:string, material:string, occupancyPct:number, statuses:string[]}>}
 */
export function sanitizeInners(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  let used = 0;
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const id = _id(item.id ?? item.slotKey);
    if (!id) continue;
    const occupancyPct = Math.max(0, Number(item.occupancyPct ?? item.pct ?? 0) || 0);
    const remaining = Math.max(0, 100 - used);
    const pct = Math.min(occupancyPct, remaining);
    used += pct;
    const statuses = Array.isArray(item.statuses)
      ? item.statuses.map((s) => String(s ?? '').trim()).filter(Boolean)
      : [];
    out.push({
      id,
      name: String(item.name ?? '').trim() || id,
      material: String(item.material ?? '').trim() || DEFAULT_PART_MATERIAL,
      occupancyPct: pct,
      statuses,
    });
    if (used >= 100) break;
  }
  return out;
}

/**
 * Migrate leftover `organs: [{slotKey,name}]` into inners when `inners` is empty.
 * @param {object} part
 * @returns {Array}
 */
export function innersFromPart(part) {
  if (Array.isArray(part?.inners) && part.inners.length) return sanitizeInners(part.inners);
  const organs = Array.isArray(part?.organs) ? part.organs : [];
  if (!organs.length) return [];
  return sanitizeInners(organs.map((o) => ({
    id: o?.id ?? o?.slotKey,
    name: o?.name,
    material: o?.material ?? DEFAULT_PART_MATERIAL,
    occupancyPct: Number(o?.occupancyPct ?? 0) || 0,
    statuses: o?.statuses,
  })));
}

/**
 * @param {unknown} raw
 * @returns {string} catalog slug, never empty
 */
export function sanitizePartMaterial(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return DEFAULT_PART_MATERIAL;
  if (LEGACY_INJURY_CATEGORY[v]) return DEFAULT_PART_MATERIAL;
  return v;
}

/**
 * Injury-description category from catalog material (or legacy category ids).
 * @param {object|null|undefined} part
 * @param {(id:string)=>object|null} [getMaterial]
 * @returns {'biological'|'bionic'}
 */
export function injuryCategoryForPart(part, getMaterial) {
  const raw = String(part?.material ?? '').trim();
  if (LEGACY_INJURY_CATEGORY[raw]) return LEGACY_INJURY_CATEGORY[raw];
  if (typeof getMaterial === 'function' && raw) {
    try {
      const md = getMaterial(raw);
      const cat = String(md?.category ?? '').trim().toLowerCase();
      if (cat === 'bionic' || cat === 'mechanical' || cat === 'synthetic') return 'bionic';
    } catch (_) { /* ignore */ }
  }
  return 'biological';
}

export function sanitizeHeightFrac(raw, fallback = 0.5) {
  return _clamp01(raw, fallback);
}

export function sanitizeHeightM(raw, fallback = DEFAULT_ANATOMY_HEIGHT_M) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Floor height of a part in meters.
 * @param {object} part
 * @param {number} actorHeightM
 */
export function partHeightM(part, actorHeightM) {
  const h = sanitizeHeightM(actorHeightM, DEFAULT_ANATOMY_HEIGHT_M);
  return sanitizeHeightFrac(part?.heightFrac, 0.5) * h;
}

/**
 * @param {unknown} raw
 * @param {string[]} [validPartIds]
 * @returns {Array<{id:string, type:string, name:string, parts:string[]}>}
 */
export function sanitizeAnatomyGroups(raw, validPartIds) {
  const src = Array.isArray(raw) ? raw : [];
  const valid = validPartIds ? new Set(validPartIds.map(String)) : null;
  const out = [];
  const seenIds = new Set();
  for (const g of src) {
    if (!g || typeof g !== 'object') continue;
    const id = _id(g.id);
    if (!id || seenIds.has(id)) continue;
    const type = String(g.type ?? '').trim();
    if (!ANATOMY_GROUP_TYPES.includes(type)) continue;
    const parts = [];
    const seenParts = new Set();
    const rawParts = Array.isArray(g.parts) ? g.parts : [];
    for (const p of rawParts) {
      const pid = _id(p);
      if (!pid || seenParts.has(pid)) continue;
      if (valid && !valid.has(pid)) continue;
      seenParts.add(pid);
      parts.push(pid);
    }
    seenIds.add(id);
    out.push({
      id,
      type,
      name: String(g.name ?? '').trim() || id,
      parts,
    });
  }
  return out;
}

/**
 * Remap group.parts using rawKey → slotRef after actor normalization.
 * @param {Array} groups
 * @param {Record<string,string>} rawKeyToSlotRef
 * @param {string[]} validSlotRefs
 */
export function remapGroupParts(groups, rawKeyToSlotRef, validSlotRefs) {
  const map = rawKeyToSlotRef && typeof rawKeyToSlotRef === 'object' ? rawKeyToSlotRef : {};
  const valid = new Set((validSlotRefs ?? []).map(String));
  return sanitizeAnatomyGroups(
    (Array.isArray(groups) ? groups : []).map((g) => ({
      ...g,
      parts: (Array.isArray(g?.parts) ? g.parts : []).map((p) => {
        const key = String(p ?? '').trim();
        if (map[key]) return map[key];
        if (valid.has(key)) return key;
        const typeMatch = [...valid].find((slot) => slot === key || slot.startsWith(`${key}#`));
        return typeMatch || key;
      }),
    })),
    [...valid],
  );
}

export function readActorGroups(actor) {
  const system = actor?.system ?? actor ?? {};
  const groups = system?.anatomy?.groups;
  const bodyParts = system?.health?.bodyParts ?? {};
  return sanitizeAnatomyGroups(groups, Object.keys(bodyParts));
}

export function getAnatomyGroups(actor) {
  return readActorGroups(actor);
}

export function getGroupsByType(actor, type) {
  const t = String(type ?? '').trim();
  return readActorGroups(actor).filter((g) => g.type === t);
}

export function getPartGroups(actor, slotRef) {
  const id = String(slotRef ?? '').trim();
  if (!id) return [];
  const bodyParts = actor?.system?.health?.bodyParts ?? {};
  const typeId = String(bodyParts[id]?.id ?? '').trim();
  return readActorGroups(actor).filter((g) =>
    g.parts.includes(id) || (typeId && g.parts.includes(typeId)),
  );
}

/**
 * Group ability = sum currentHp / sum maxHp of member parts (0–1).
 * Missing / unknown parts are skipped; empty group → 0.
 * @param {object} actor
 * @param {string} groupId
 * @returns {number}
 */
export function getGroupAbility(actor, groupId) {
  const id = String(groupId ?? '').trim();
  const group = readActorGroups(actor).find((g) => g.id === id);
  if (!group) return 0;
  const bodyParts = actor?.system?.health?.bodyParts ?? {};
  let cur = 0;
  let max = 0;
  for (const partKey of group.parts) {
    const part = bodyParts[partKey]
      ?? Object.values(bodyParts).find((p) => String(p?.id ?? '') === partKey)
      ?? null;
    if (!part) continue;
    const maxHp = Math.max(0, Number(part.maxHp) || 0);
    max += maxHp;
    const current = Number(part.currentHp);
    if (Number.isFinite(current)) cur += Math.max(0, current);
    else {
      const pct = Number(part.healthPercentage);
      cur += Number.isFinite(pct) ? maxHp * Math.max(0, Math.min(100, pct)) / 100 : maxHp;
    }
  }
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, cur / max));
}

/**
 * Slot refs belonging to a group (expand type ids to actor slotRefs).
 * @param {Record<string, object>} bodyParts
 * @param {{parts:string[]}} group
 * @returns {string[]}
 */
export function groupSlotRefs(bodyParts, group) {
  const parts = bodyParts && typeof bodyParts === 'object' ? bodyParts : {};
  const keys = Object.keys(parts);
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(group?.parts) ? group.parts : []) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const matches = [];
    if (parts[id]) matches.push(id);
    for (const slot of keys) {
      if (String(parts[slot]?.id ?? '') === id) matches.push(slot);
    }
    for (const slot of matches) {
      if (seen.has(slot)) continue;
      seen.add(slot);
      out.push(slot);
    }
  }
  return out;
}

/**
 * Groups that still have at least one living part (maxHp > 0).
 * @param {object} actor
 */
export function availableHitGroups(actor) {
  const bodyParts = actor?.system?.health?.bodyParts ?? {};
  return readActorGroups(actor).filter((g) => {
    const slots = groupSlotRefs(bodyParts, g);
    return slots.some((slot) => Math.max(0, Number(bodyParts[slot]?.maxHp) || 0) > 0);
  });
}

export function remapLegacyPartId(rawId) {
  const id = String(rawId ?? '').trim();
  return LEGACY_HUMANOID_PART_REMAP[id] ?? null;
}

/**
 * Strip deprecated part fields after sanitize.
 * @param {object} part
 */
export function stripDeprecatedPartFields(part) {
  if (!part || typeof part !== 'object') return part;
  delete part.exposure;
  delete part.bodyLayers;
  delete part.status;
  delete part.internal;
  delete part.position3d;
  delete part.weight;
  delete part.organs;
  return part;
}
