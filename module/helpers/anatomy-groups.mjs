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

/** Organ tag: destroying (or losing) such an organ kills the body. */
export const INNER_TAG_VITAL = 'vital';

export const DEFAULT_ANATOMY_HEIGHT_M = 1.75;

/** Base combat speed of a species (m/s) when the anatomy preset does not define `speedMps`. */
export const DEFAULT_ANATOMY_SPEED_MPS = 3;
export const DEFAULT_PART_MATERIAL = 'skin';

/**
 * How a part takes a projectile (`part.tissue`), see `body-traversal-resolver.mjs`:
 * - `shellThickness` — thickness of the part's own `material` (skin, the skull) as the outer shell:
 *   a projectile weaker than it stays in the shell and reaches no organ;
 * - `depthFlat` + `depthShare` — energy the inside of the part absorbs: a flat amount plus a share of
 *   what entered (a deep torso keeps more than a thin arm); the rest leaves the body;
 * - `organDepth` — energy the projectile still needs past the shell to reach the organs;
 * - `cavity` — extra damage per unit of energy the inside of the part absorbs (the temporary cavity: a
 *   high-energy round tears more than its share of damage; brain and bone take it worse than elastic flesh);
 * - `bluntToParent` — share of a blow the part passes to its parent (a helmet hit to the neck);
 * - `bleed` — % of blood per minute a wound as large as the part's whole HP bleeds.
 */
export const DEFAULT_PART_TISSUE = Object.freeze({
  shellThickness: 1,
  depthFlat: 1,
  depthShare: 0.5,
  organDepth: 1,
  cavity: 0,
  bluntToParent: 0,
  bleed: 5,
});

/**
 * How a part takes damage as a whole (`part.structure`; not tissue — robots have it too):
 * - `saturation` — hits of one strength push the part at most this many times as far as one such hit does to a
 *   fresh part (the first hit counts in full, the next ones less, weak ones stop mattering); 0 = no limit;
 * - `reserve` — at 0 HP the part is disabled; it is destroyed only at −`reserve` of its HP (share of max HP).
 * Defaults keep the plain behaviour: damage adds up, 0 HP = destroyed.
 */
export const DEFAULT_PART_STRUCTURE = Object.freeze({
  saturation: 0,
  reserve: 0,
});

/** Bleeding of an organ (% of blood per minute for a wound as large as its HP) when the preset gives none. */
export const DEFAULT_INNER_BLEED = 5;

/**
 * A vital organ makes the body dying once it has lost this share of its HP: almost any real wound of the brain
 * or the heart, but not a graze by a spent fragment or a bruise through armour (that is a severe wound).
 */
export const MORTAL_ORGAN_SHARE = 0.25;

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

function _nonNegative(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The part's tissue with defaults filled in (see {@link DEFAULT_PART_TISSUE}).
 * @param {object|null|undefined} part
 * @returns {{material: string, shellThickness: number, depthFlat: number, depthShare: number, organDepth: number, cavity: number, bluntToParent: number, bleed: number}}
 */
export function partTissue(part) {
  const src = part?.tissue && typeof part.tissue === 'object' ? part.tissue : {};
  const d = DEFAULT_PART_TISSUE;
  return {
    material: sanitizePartMaterial(part?.material),
    shellThickness: _nonNegative(src.shellThickness, d.shellThickness),
    depthFlat: _nonNegative(src.depthFlat, d.depthFlat),
    depthShare: Math.min(1, _nonNegative(src.depthShare, d.depthShare)),
    organDepth: _nonNegative(src.organDepth, d.organDepth),
    cavity: _nonNegative(src.cavity, d.cavity),
    bluntToParent: Math.min(1, _nonNegative(src.bluntToParent, d.bluntToParent)),
    bleed: _nonNegative(src.bleed, d.bleed),
  };
}

/**
 * The part's structure with defaults filled in (see {@link DEFAULT_PART_STRUCTURE}). A saturation below 1 cannot
 * hold even one full hit, so it means "no limit".
 * @param {object|null|undefined} part
 * @returns {{saturation: number, reserve: number}}
 */
export function partStructure(part) {
  const src = part?.structure && typeof part.structure === 'object' ? part.structure : {};
  const d = DEFAULT_PART_STRUCTURE;
  const saturation = _nonNegative(src.saturation, d.saturation);
  return {
    saturation: saturation >= 1 ? saturation : 0,
    reserve: _nonNegative(src.reserve, d.reserve),
  };
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
 * Organs of a part: a share of the part (`occupancyPct`, sum ≤ 100), own HP (`maxHp`, 0 = no HP, never
 * damaged), bleeding when hit (`bleed`, see {@link DEFAULT_INNER_BLEED}), the share of HP a vital organ may lose
 * before the body is dying (`mortalShare`, default {@link MORTAL_ORGAN_SHARE}; the brain less) and tags
 * (`vital`). Their state is derived from injuries, never stored.
 * @param {unknown} raw
 * @returns {Array<{id:string, name:string, material:string, occupancyPct:number, maxHp:number, bleed:number, mortalShare?:number, tags:string[]}>}
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
    const tags = Array.isArray(item.tags)
      ? [...new Set(item.tags.map((t) => String(t ?? '').trim()).filter(Boolean))]
      : [];
    out.push({
      id,
      name: String(item.name ?? '').trim() || id,
      material: String(item.material ?? '').trim() || DEFAULT_PART_MATERIAL,
      occupancyPct: pct,
      maxHp: Math.max(0, Number(item.maxHp) || 0),
      bleed: _nonNegative(item.bleed, DEFAULT_INNER_BLEED),
      ...(item.mortalShare != null && item.mortalShare !== '' ? { mortalShare: Math.min(1, _nonNegative(item.mortalShare, MORTAL_ORGAN_SHARE)) } : {}),
      tags,
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
    maxHp: o?.maxHp,
    bleed: o?.bleed,
    mortalShare: o?.mortalShare,
    tags: o?.tags,
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
 * Base combat speed of a species, m/s (anatomy `speedMps`; AGI 100 gives exactly this).
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {number}
 */
export function sanitizeSpeedMps(raw, fallback = DEFAULT_ANATOMY_SPEED_MPS) {
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
 * A part that can still be hit: it has HP to lose and has not been lost (see `computeLostParts`).
 * @param {object} part
 * @returns {boolean}
 */
export function isPartAlive(part) {
  return Math.max(0, Number(part?.maxHp) || 0) > 0 && !part?.lost;
}

/**
 * Slot refs belonging to a group (expand type ids to actor slotRefs).
 * @param {Record<string, object>} bodyParts
 * @param {{parts:string[]}} group
 * @param {{aliveOnly?: boolean}} [opts] - leave out lost parts and parts without HP
 * @returns {string[]}
 */
export function groupSlotRefs(bodyParts, group, { aliveOnly = false } = {}) {
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
      if (aliveOnly && !isPartAlive(parts[slot])) continue;
      seen.add(slot);
      out.push(slot);
    }
  }
  return out;
}

/**
 * Groups that still have at least one part that can be hit (has HP, not lost).
 * @param {object} actor
 */
export function availableHitGroups(actor) {
  const bodyParts = actor?.system?.health?.bodyParts ?? {};
  return readActorGroups(actor).filter((g) => groupSlotRefs(bodyParts, g, { aliveOnly: true }).length > 0);
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
  // Derived at runtime from injuries and the part tree.
  delete part.lost;
  delete part.lostVia;
  return part;
}

/* ================================================================== *
 *  Organ state (derived from injuries)                                 *
 * ================================================================== */

export const INNER_STATUS = Object.freeze({
  OK: 'ok',
  DAMAGED: 'damaged',
  DESTROYED: 'destroyed',
  LOST: 'lost',
});

/**
 * @param {object} inner
 * @returns {boolean} true when the organ carries the `vital` tag
 */
export function isVitalInner(inner) {
  return Array.isArray(inner?.tags) && inner.tags.includes(INNER_TAG_VITAL);
}

/**
 * Derived state of an organ: its HP (scaled like the parts' by END) minus the damage it took, and a status.
 * An organ without HP (`maxHp` 0) is never damaged; an organ of a lost part is lost with it.
 * @param {{maxHp?: number}} inner
 * @param {{damageAmount?: number, hpScale?: number, lost?: boolean}} [ctx] - `damageAmount` in the x100 scale of injuries
 * @returns {{effectiveMaxHp: number, currentHp: number, lost: boolean, status: string}}
 */
export function computeInnerState(inner, { damageAmount = 0, hpScale = 1, lost = false } = {}) {
  const baseMax = Math.max(0, Number(inner?.maxHp) || 0);
  const scale = Number.isFinite(hpScale) && hpScale > 0 ? hpScale : 1;
  const effectiveMaxHp = scale === 1 ? baseMax : Math.ceil(baseMax * scale);
  const damaged = Math.floor(Math.max(0, Number(damageAmount) || 0) / 100);
  const currentHp = lost ? 0 : Math.max(0, effectiveMaxHp - damaged);
  let status = INNER_STATUS.OK;
  if (lost) status = INNER_STATUS.LOST;
  else if (effectiveMaxHp > 0 && currentHp <= 0) status = INNER_STATUS.DESTROYED;
  else if (effectiveMaxHp > 0 && currentHp < effectiveMaxHp) status = INNER_STATUS.DAMAGED;
  return { effectiveMaxHp, currentHp, lost: Boolean(lost), status };
}

/* ================================================================== *
 *  Death                                                               *
 * ================================================================== */

/**
 * State of the body:
 * - **dead** — the root part is lost (the head of a humanoid: everything went with it), or a `vital` organ is
 *   destroyed or lost (the brain, the heart);
 * - **dying** — a `vital` organ lost at least its `mortalShare` of HP ({@link MORTAL_ORGAN_SHARE} by default; the
 *   brain less) but is not destroyed (a bullet in the brain), or the body bleeds out
 *   faster than `MORTAL_BLEED_MINUTES` (`bleeding.mortal`, see `damage/bleeding.mjs`): out of action, dies
 *   without extraordinary help.
 * @param {Record<string, object>} bodyParts - prepared parts (`lost`, `inners` with the derived `status`)
 * @param {string} [rootRef] - slot of the root part
 * @param {{ bleeding?: { mortal?: boolean, minutesToDeath?: number }|null }} [ctx]
 * @returns {{dead: boolean, dying: boolean, reason: 'root'|'organ'|'bleeding'|null, slotRef: string|null,
 *   innerId: string|null, minutesToDeath?: number}}
 */
export function computeDeathState(bodyParts, rootRef, { bleeding = null } = {}) {
  const parts = bodyParts && typeof bodyParts === 'object' ? bodyParts : {};
  const root = _id(rootRef);
  if (root && parts[root]?.lost) return { dead: true, dying: false, reason: 'root', slotRef: root, innerId: null };
  let damaged = null;
  for (const [slotRef, part] of Object.entries(parts)) {
    for (const inner of Array.isArray(part?.inners) ? part.inners : []) {
      if (!isVitalInner(inner)) continue;
      if (inner.status === INNER_STATUS.DESTROYED || inner.status === INNER_STATUS.LOST) {
        return { dead: true, dying: false, reason: 'organ', slotRef, innerId: _id(inner.id) || null };
      }
      const max = Number(inner.effectiveMaxHp ?? inner.maxHp) || 0;
      const lostShare = max > 0 ? (max - (Number(inner.currentHp ?? max) || 0)) / max : 0;
      const mortalShare = Number.isFinite(Number(inner.mortalShare)) ? Number(inner.mortalShare) : MORTAL_ORGAN_SHARE;
      if (!damaged && inner.status === INNER_STATUS.DAMAGED && lostShare >= mortalShare - 1e-9) {
        damaged = { slotRef, innerId: _id(inner.id) || null };
      }
    }
  }
  if (damaged) return { dead: false, dying: true, reason: 'organ', ...damaged };
  if (bleeding?.mortal) {
    return { dead: false, dying: true, reason: 'bleeding', slotRef: null, innerId: null, minutesToDeath: bleeding.minutesToDeath };
  }
  return { dead: false, dying: false, reason: null, slotRef: null, innerId: null };
}
