/**
 * Penetration track — the record of how one projectile went through the layers in its way: walls, the
 * armour of a body, the body part itself, then the next wall or body. It is what the penetration view
 * (`penetration-view-app.mjs`) plays back, so it keeps the numbers of every layer: the projectile's energy
 * entering and leaving it, the damage entering and leaving it, the resistance the layer offered.
 *
 * Pure data and maths (no Foundry globals), so it runs in plain Node
 * (`node module/helpers/damage/penetration-track.test.mjs`).
 *
 * The track is plain JSON. `AimingManager` builds one per ray, from the traces the resolvers already write
 * (`resolveDamagePackage`, `resolveBodyTraversal`, `planWallPasses`), and `weapon/attack-log.mjs` keeps it in
 * the shot entry of the attack log — so it travels with the chat message and any client can open it by the
 * shot id (`shot_…`, the id of the shot's trail record).
 *
 * Shape:
 * - `PenetrationTrack`: `{ v, shotId, projectile, energy, streams?, groups: TrackGroup[] }` — `energy` is the muzzle
 *   energy the percentages refer to; `streams` (the track of a whole shot, `penetration-shot.mjs`): the ids of the
 *   projectiles' ways through the shot, in the order its groups meet them — each has a lane in the view
 * - `TrackGroup`: `{ kind: 'wall'|'body', title, subtitle?, img?, hit?, tokenId?, at?, scale?, quality?, pending?,
 *   parallel?, lanes?, rays?, stages: TrackStage[] }` — a wall (or several walls in a row), or a body the projectile reached (`title` the
 *   target, `subtitle` the part, `img` the target's picture); `hit` is the index of the hit (of the ray's
 *   impacts in the attack log) the body belongs to, `tokenId` / `at` where it is on the scene (the token, the
 *   point of the hit — or of the wall); `scale` is the share of the projectile's energy that reached the body
 *   (hit quality, distance) and `quality` its label; `pending`: the damage waits for the GM, so only the walls
 *   in front are known; `parallel`: the group does not continue the one before it (a blast reaches every target
 *   at once); `lanes` / `rays`: the group is the wound of several projectiles (the pellets of a volley that
 *   landed together) — `rays` their ray ids, and every item of its stages says which one it is (`lane`);
 *   `streams`: the streams (indexes into the track's `streams`) that meet the group, in the order of its lanes
 * - `TrackStage`: one layer — `{ kind: 'wall'|'armor'|'tissue', side?: 'entry'|'exit', verdict: 'pass'|'hold'|'skip',
 *   skip?, name, material?, thickness?, source?, resist?, items: TrackItem[], notes?, lostBefore? }`
 * - `TrackItem`: one damage type of the projectile at that layer — `{ type, verdict, eIn, eOut, dIn, dOut, lane? }`
 */

import { normalizeApplications, projectileEnergy } from './damage-resolver.mjs';

export const PENETRATION_TRACK_VERSION = 1;

/** Tracks kept inside one attack log; later shots keep their results but not the track (size guard). */
export const MAX_TRACKS_PER_LOG = 60;
const MAX_GROUPS = 16;
const MAX_STAGES_PER_GROUP = 24;
/** Projectiles (lanes) one group keeps, and the items one stage keeps (a lane may bring a few). */
export const MAX_LANES = 16;
const MAX_ITEMS_PER_STAGE = 2 * MAX_LANES;
/** Shocks, organs and the like kept on one stage. */
const MAX_NOTES_PER_STAGE = 6;
const MAX_TEXT = 120;
/** Streams one shot track keeps (the view draws {@link MAX_LANES} of them). */
export const MAX_STREAMS = 32;
/** Longest picture path kept. */
const MAX_IMG = 260;

const EPS = 1e-9;
/** Energy lost between two layers below this is rounding, not a flight loss worth a line. */
const LOST_BEFORE_MIN = 0.01;

const VERDICTS = new Set(['pass', 'hold', 'skip']);
const KINDS = new Set(['wall', 'armor', 'tissue']);
const SIDES = new Set(['entry', 'exit']);
const SKIPS = new Set(['degraded', 'gap']);

/* -------------------------------------------- */
/*  Small helpers                               */
/* -------------------------------------------- */

function num(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isFinite(n) ? n : null;
}

/** A number rounded to hundredths, `null` when it is not a number. */
function round2(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

function text(value) {
  const s = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/** A picture path: no script or data URLs, bounded. */
function imagePath(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > MAX_IMG || /^\s*(javascript|data|vbscript):/i.test(s)) return '';
  return s;
}

/** A point on the scene rounded to 0.1, `undefined` when it is not one. */
function scenePoint(raw) {
  const x = num(raw?.x);
  const y = num(raw?.y);
  if (x === null || y === null) return undefined;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function pickDefined(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

/* -------------------------------------------- */
/*  Energy of a projectile                      */
/* -------------------------------------------- */

/**
 * The energy a projectile carries: the biggest of its application items (the one that drives penetration).
 * @param {unknown} applications phased applications package (anything `normalizeApplications` takes)
 * @returns {number|null} `null` when the package is empty
 */
export function applicationsEnergy(applications) {
  let best = null;
  for (const phase of normalizeApplications(applications)) {
    for (const item of phase.items) {
      const energy = Number.isFinite(item.energy) ? item.energy : projectileEnergy(item.damage, item);
      if (best === null || energy > best) best = energy;
    }
  }
  return best === null ? null : round2(best);
}

/* -------------------------------------------- */
/*  Reading the resolvers' traces               */
/* -------------------------------------------- */

/**
 * The item with the most energy entering the layer: the one the strip shows (the others are in the tooltip).
 * @param {{items?: object[]}} stage
 * @returns {object|null}
 */
export function primaryItem(stage) {
  let best = null;
  for (const item of stage?.items ?? []) {
    if (!best || (num(item.eIn) ?? 0) > (num(best.eIn) ?? 0) + EPS) best = item;
  }
  return best;
}

function newStage(kind, event, names) {
  const thickness = num(event.thickness);
  return {
    kind,
    side: event.phase === 'entry' || event.phase === 'exit' ? event.phase : undefined,
    verdict: 'skip',
    name: text(names.materialName?.(event.material) ?? event.material ?? ''),
    material: text(event.material),
    thickness: thickness === null ? undefined : round2(thickness),
    source: kind === 'armor' && event.layerKey ? text(names.sourceName?.(event.layerKey) ?? '') : '',
    resist: undefined,
    items: [],
    notes: {},
  };
}

/** `{ lane }` when the event is labelled with the projectile it belongs to (the pellet of a volley), else nothing. */
function laneOf(event) {
  return Number.isInteger(event?.tag) && event.tag >= 0 ? { lane: event.tag } : {};
}

function addNote(stage, key, value) {
  if (value === undefined || value === null) return;
  stage.notes[key] = value;
}

/**
 * Group the events of the resolvers' traces into layers: every event of one layer (the penetrations and holds
 * of each damage type, the shock it conducted, the wear) becomes one stage. Events of the body traversal carry
 * `slotRef` and `phase`; those of a plain stack (a wall span) do not.
 *
 * @param {object[]} trace events of `resolveDamagePackage` / `resolveBodyTraversal`
 * @param {object} [names]
 * @param {(slug: string) => string} [names.materialName]
 * @param {(layerKey: string) => string} [names.sourceName] armour piece the layer belongs to
 * @param {string} [names.kind='armor'] `wall` for the layer of a wall span
 * @returns {object[]} stages in flight order, `slotRef` kept (private to the caller) as `slot`
 */
export function layerStages(trace, names = {}) {
  const kind = names.kind === 'wall' ? 'wall' : 'armor';
  const stages = new Map();
  const slotOrder = new Map();
  const touch = (event, key, layerIndex) => {
    let entry = stages.get(key);
    if (!entry) {
      if (!slotOrder.has(event.slotRef ?? '')) slotOrder.set(event.slotRef ?? '', slotOrder.size);
      entry = { stage: newStage(kind, event, names), slot: event.slotRef ?? '', phase: event.phase ?? '', layerIndex, seq: stages.size };
      stages.set(key, entry);
    }
    return entry.stage;
  };

  for (const event of Array.isArray(trace) ? trace : []) {
    if (!event || typeof event !== 'object') continue;
    const key = `${event.slotRef ?? ''}|${event.phase ?? ''}|${event.layerIndex}`;
    switch (event.kind) {
      case 'penetrate': {
        const stage = touch(event, key, event.layerIndex);
        stage.items.push({
          type: text(event.type),
          verdict: 'pass',
          eIn: round2(event.energyBefore),
          eOut: round2(event.energyAfter),
          dIn: round2(event.incoming),
          dOut: round2(event.residual),
          ...laneOf(event),
        });
        stage.resist = Math.max(stage.resist ?? 0, round2(event.eAR) ?? 0);
        stage.notes.wear = round2((stage.notes.wear ?? 0) + (num(event.wear) ?? 0));
        addNote(stage, 'integrity', round2(event.integrityAfter));
        break;
      }
      case 'hold': {
        const stage = touch(event, key, event.layerIndex);
        stage.items.push({
          type: text(event.type),
          verdict: 'hold',
          eIn: round2(event.energyBefore),
          eOut: 0,
          dIn: round2(event.incoming),
          dOut: 0,
          ...laneOf(event),
        });
        stage.resist = Math.max(stage.resist ?? 0, round2(event.eAR) ?? 0);
        stage.notes.wear = round2((stage.notes.wear ?? 0) + (num(event.wear) ?? 0));
        addNote(stage, 'integrity', round2(event.integrityAfter));
        break;
      }
      case 'bypass': {
        const stage = touch(event, key, event.layerIndex);
        stage.items.push({
          type: text(event.type),
          verdict: 'skip',
          eIn: round2(event.energy),
          eOut: round2(event.energy),
          dIn: round2(event.amount),
          dOut: round2(event.amount),
          ...laneOf(event),
        });
        stage.skip = 'degraded';
        addNote(stage, 'mode', text(event.mode));
        break;
      }
      case 'gap': {
        // A layer the hit missed through a coverage gap: sits between the layers around it.
        const gapKey = `${event.slotRef ?? ''}|${event.phase ?? ''}|gap:${event.layerKey}`;
        const stage = touch(event, gapKey, (num(event.before) ?? 0) - 0.5);
        stage.skip = 'gap';
        addNote(stage, 'coverage', round2(event.coverage));
        break;
      }
      case 'conduct': {
        const stage = touch(event, key, event.layerIndex);
        const shocks = (Array.isArray(event.items) ? event.items : [])
          .map((item) => ({ type: text(item?.type), amount: round2(item?.amount) }))
          .filter((item) => item.type && item.amount > 0);
        if (shocks.length) stage.notes.conduct = [...(stage.notes.conduct ?? []), ...shocks];
        break;
      }
      case 'damp': {
        const stage = touch(event, key, event.layerIndex);
        stage.notes.damped = [...(stage.notes.damped ?? []), { type: text(event.type), before: round2(event.before), after: round2(event.after) }];
        break;
      }
      default:
        break;
    }
  }

  const PHASE_ORDER = { entry: 0, tissue: 1, exit: 2, '': 0 };
  return [...stages.values()]
    .sort((a, b) => (slotOrder.get(a.slot) - slotOrder.get(b.slot))
      || ((PHASE_ORDER[a.phase] ?? 0) - (PHASE_ORDER[b.phase] ?? 0))
      || (a.layerIndex - b.layerIndex)
      || (a.seq - b.seq))
    .map((entry) => ({ ...finishStage(entry.stage), slot: entry.slot, phase: entry.phase }));
}

/** The verdict of a stage is that of its primary item; a stage without items is skipped. */
function finishStage(stage) {
  const primary = primaryItem(stage);
  stage.verdict = primary ? primary.verdict : 'skip';
  if (stage.verdict !== 'skip') delete stage.skip;
  return stage;
}

/**
 * The stage(s) of the walls a projectile met, in order. A wall that was passed or that stopped the projectile
 * has the resolver's trace of the span; a wall that held without material data (`opaque`, `unbounded`) has none.
 *
 * @param {object[]} events `planWallPasses` events (with their `trace`)
 * @param {{materialName?: (slug: string) => string}} [names]
 * @returns {object[]} stages
 */
export function wallStages(events, names = {}) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const traced = layerStages(event.trace, { ...names, kind: 'wall' });
    const thickness = Number.isFinite(event.thickness) && event.thickness > 0 ? round2(event.thickness) : undefined;
    if (traced.length) {
      for (const stage of traced) {
        stage.name ||= text(names.materialName?.(event.material) ?? event.material ?? '');
        if (stage.thickness === undefined && thickness !== undefined) stage.thickness = thickness;
        out.push(stage);
      }
      continue;
    }
    // No trace: the wall stopped the shot outright (no material, or no far face to leave through).
    const stage = newStage('wall', { material: event.material, thickness: event.thickness }, names);
    stage.verdict = 'hold';
    addNote(stage, 'reason', text(event.reason || 'stopped'));
    const dIn = round2(event.damageBefore);
    if (dIn !== null) stage.items.push({ type: '', verdict: 'hold', eIn: null, eOut: 0, dIn, dOut: 0 });
    out.push(stage);
  }
  return out;
}

/**
 * The groups of a body the projectile reached, from an `applyDamagePackage` result: one per body part the
 * projectile visited (a hit part, then the part behind it), each with the armour in front, the tissue and the
 * armour behind.
 *
 * @param {object} result `applyDamagePackage` result (`trace`, `innerHitsBySlot`, …)
 * @param {object} names
 * @param {string} names.target name of the body's owner
 * @param {(slotRef: string) => string} names.partName
 * @param {(slug: string) => string} [names.materialName]
 * @param {(layerKey: string) => string} [names.sourceName]
 * @param {(slotRef: string, innerId: string) => string} [names.innerName]
 * @returns {object[]} groups
 */
export function bodyGroups(result, names = {}) {
  const trace = Array.isArray(result?.trace) ? result.trace : [];
  const armour = layerStages(trace.filter((e) => e?.phase === 'entry' || e?.phase === 'exit'), { ...names, kind: 'armor' });
  const bySlot = new Map();
  const slot = (slotRef) => {
    if (!bySlot.has(slotRef)) bySlot.set(slotRef, { slotRef, stages: [] });
    return bySlot.get(slotRef);
  };

  // Visit order: the order the slots first show up in the trace.
  for (const event of trace) {
    if (event?.slotRef !== undefined) slot(event.slotRef);
  }

  for (const stage of armour) {
    const entry = slot(stage.slot);
    entry.stages.push(stage);
  }

  for (const event of trace) {
    if (event?.kind !== 'tissue') continue;
    const entry = slot(event.slotRef);
    let stage = entry.stages.find((s) => s.kind === 'tissue');
    if (!stage) {
      stage = {
        kind: 'tissue',
        verdict: 'skip',
        name: text(names.partName?.(event.slotRef) ?? event.slotRef),
        material: text(event.material),
        thickness: num(event.shellThickness) > 0 ? round2(event.shellThickness) : undefined,
        resist: 0,
        items: [],
        notes: {},
        slot: event.slotRef,
        phase: 'tissue',
      };
      entry.stages.push(stage);
    }
    const left = num(event.exit) ?? 0;
    stage.items.push({
      type: text(event.type),
      verdict: left > EPS ? 'pass' : 'hold',
      eIn: round2(event.energyBefore),
      eOut: round2(event.energyAfter),
      dIn: round2(event.damage),
      dOut: round2(left),
      ...laneOf(event),
    });
    stage.resist = Math.max(stage.resist ?? 0, round2(event.shell) ?? 0);
    stage.notes.deposit = round2((stage.notes.deposit ?? 0) + (num(event.deposit) ?? 0));
    if (event.reached) stage.notes.reachedOrgans = true;
    if (event.inShell) stage.notes.inShell = true;
  }

  const groups = [];
  for (const entry of bySlot.values()) {
    const PHASE_ORDER = { entry: 0, tissue: 1, exit: 2 };
    const stages = entry.stages
      .map(finishStage)
      .sort((a, b) => ((PHASE_ORDER[a.phase] ?? 0) - (PHASE_ORDER[b.phase] ?? 0)));
    if (!stages.length) continue;
    const tissue = stages.find((s) => s.kind === 'tissue');
    const organs = (result?.innerHitsBySlot?.[entry.slotRef] ?? [])
      .map((hit) => text(names.innerName?.(entry.slotRef, hit?.innerId) ?? hit?.innerId ?? ''))
      .filter(Boolean);
    if (tissue && organs.length) tissue.notes.organs = organs;
    for (const stage of stages) {
      delete stage.slot;
      delete stage.phase;
    }
    groups.push({
      kind: 'body',
      title: text(names.target ?? ''),
      subtitle: text(names.partName?.(entry.slotRef) ?? entry.slotRef),
      stages,
    });
  }
  return groups;
}

/* -------------------------------------------- */
/*  The track                                   */
/* -------------------------------------------- */

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    type: text(raw.type),
    verdict: VERDICTS.has(raw.verdict) ? raw.verdict : 'skip',
    eIn: round2(raw.eIn),
    eOut: round2(raw.eOut),
    dIn: round2(raw.dIn),
    dOut: round2(raw.dOut),
    ...(Number.isInteger(raw.lane) && raw.lane >= 0 && raw.lane < MAX_LANES ? { lane: raw.lane } : {}),
  };
}

function sanitizeShocks(list, fields) {
  if (!Array.isArray(list)) return undefined;
  const out = list
    .map((entry) => {
      const item = { type: text(entry?.type) };
      for (const field of fields) item[field] = round2(entry?.[field]);
      return item;
    })
    .filter((item) => item.type)
    .slice(0, MAX_NOTES_PER_STAGE);
  return out.length ? out : undefined;
}

function sanitizeNotes(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const notes = pickDefined({
    wear: round2(raw.wear) || undefined,
    integrity: round2(raw.integrity),
    mode: text(raw.mode),
    coverage: round2(raw.coverage),
    reason: text(raw.reason),
    deposit: round2(raw.deposit),
    reachedOrgans: raw.reachedOrgans === true ? true : undefined,
    inShell: raw.inShell === true ? true : undefined,
    conduct: sanitizeShocks(raw.conduct, ['amount']),
    damped: sanitizeShocks(raw.damped, ['before', 'after']),
    organs: Array.isArray(raw.organs) ? raw.organs.map(text).filter(Boolean).slice(0, MAX_NOTES_PER_STAGE) : undefined,
  });
  return Object.keys(notes).length ? notes : undefined;
}

function sanitizeStage(raw) {
  if (!raw || typeof raw !== 'object' || !KINDS.has(raw.kind)) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).map(sanitizeItem).filter(Boolean).slice(0, MAX_ITEMS_PER_STAGE);
  const primary = primaryItem({ items });
  const verdict = VERDICTS.has(raw.verdict) ? raw.verdict : (primary?.verdict ?? 'skip');
  return pickDefined({
    kind: raw.kind,
    side: SIDES.has(raw.side) ? raw.side : undefined,
    verdict,
    skip: verdict === 'skip' && SKIPS.has(raw.skip) ? raw.skip : undefined,
    name: text(raw.name),
    material: text(raw.material),
    thickness: num(raw.thickness) > 0 ? round2(raw.thickness) : undefined,
    source: text(raw.source),
    resist: num(raw.resist) > 0 ? round2(raw.resist) : undefined,
    lostBefore: num(raw.lostBefore) > 0 ? round2(raw.lostBefore) : undefined,
    items,
    notes: sanitizeNotes(raw.notes),
  });
}

function sanitizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stages = (Array.isArray(raw.stages) ? raw.stages : []).map(sanitizeStage).filter(Boolean).slice(0, MAX_STAGES_PER_GROUP);
  const pending = raw.pending === true;
  if (!stages.length && !pending) return null;
  const rays = (Array.isArray(raw.rays) ? raw.rays : []).map(text).filter(Boolean).slice(0, MAX_LANES);
  const lanes = Number.isInteger(raw.lanes) && raw.lanes > 1 ? Math.min(raw.lanes, MAX_LANES) : 0;
  const streams = (Array.isArray(raw.streams) ? raw.streams : []).filter((k) => Number.isInteger(k) && k >= 0 && k < MAX_STREAMS).slice(0, MAX_LANES);
  return pickDefined({
    kind: raw.kind === 'wall' ? 'wall' : 'body',
    title: text(raw.title),
    subtitle: text(raw.subtitle),
    img: imagePath(raw.img),
    hit: Number.isInteger(raw.hit) && raw.hit >= 0 ? raw.hit : undefined,
    tokenId: text(raw.tokenId),
    at: scenePoint(raw.at),
    scale: num(raw.scale) !== null && Math.abs(num(raw.scale) - 1) > 1e-3 ? round2(raw.scale) : undefined,
    quality: text(raw.quality),
    pending: pending ? true : undefined,
    parallel: raw.parallel === true ? true : undefined,
    lanes: lanes || undefined,
    rays: lanes && rays.length ? rays : undefined,
    streams: streams.length ? streams : undefined,
    stages,
  });
}

/** The stream ids of a shot track, cleaned. */
function cleanStreams(raw) {
  const list = (Array.isArray(raw) ? raw : []).map(text).filter(Boolean).slice(0, MAX_STREAMS);
  return list.length ? list : undefined;
}

/**
 * What the groups of a track are about, projectile by projectile: the streams (ids, in the order the groups meet
 * them) and for each group the streams that meet it, as indexes. A shot track says it itself; any other (one ray's)
 * is read from its groups: the ray is one stream, the wound of several pellets has a stream for each (`rays`), and
 * a group a blast made (`parallel`) is a stream of its own — it does not go on from the one before it.
 * @param {{ shotId?: string, streams?: string[], groups?: object[] }|null} track
 * @returns {{ streams: string[], blockStreams: number[][] }}
 */
export function trackStreams(track) {
  const groups = Array.isArray(track?.groups) ? track.groups : [];
  if (Array.isArray(track?.streams) && track.streams.length && groups.every((group) => Array.isArray(group.streams))) {
    return { streams: track.streams, blockStreams: groups.map((group) => group.streams) };
  }
  const streams = [];
  const blockStreams = groups.map((group, g) => {
    const ids = Array.isArray(group.rays) && group.rays.length > 1
      ? group.rays
      : [group.parallel === true ? `${track?.shotId ?? ''}#${g}` : `${track?.shotId ?? ''}`];
    return ids.map((id) => {
      const k = streams.indexOf(id);
      return k >= 0 ? k : streams.push(id) - 1;
    });
  });
  return { streams, blockStreams };
}

/**
 * What a group is about when it is a body: the token it is on (a target's parts of the body are groups of the
 * same token). `null` for a wall — every wall is a thing of its own.
 * @param {{ kind?: string, tokenId?: string, title?: string }|null} group
 * @returns {string|null}
 */
export function groupTokenKey(group) {
  if (!group || group.kind === 'wall') return null;
  const id = text(group.tokenId) || text(group.title);
  return id ? `body|${id}` : null;
}

/** Energy that left a layer: that of its primary item when it went through, otherwise nothing. */
function energyLeaving(stage) {
  if (stage.verdict === 'hold') return 0;
  const primary = primaryItem(stage);
  return num(primary?.eOut);
}

/** Mark the layers the projectile reached with less energy than the previous layer let go (flight, glancing hit). */
function markFlightLosses(groups) {
  let carried = null;
  for (const group of groups) {
    // The primary item of a stage of several projectiles is a different pellet from layer to layer: no loss to tell.
    if (group.lanes > 1) {
      carried = null;
      continue;
    }
    for (const stage of group.stages) {
      const primary = primaryItem(stage);
      const entering = num(primary?.eIn);
      if (stage.verdict !== 'skip' && carried !== null && entering !== null && carried - entering > LOST_BEFORE_MIN) {
        stage.lostBefore = round2(carried - entering);
      }
      if (stage.verdict === 'skip') continue;
      carried = energyLeaving(stage);
    }
  }
}

/**
 * Build a track from its groups. Groups are cleaned and capped, the energy reference defaults to the energy
 * entering the first layer.
 *
 * @param {Object} args
 * @param {string} args.shotId id of the shot (the ray) — `shot_…`
 * @param {string} [args.projectile] name of the projectile (the ammo)
 * @param {number|null} [args.energy] muzzle energy the percentages refer to
 * @param {object[]} args.groups groups in flight order (`wallStages` / `bodyGroups` wrapped by the caller)
 * @param {string[]} [args.streams] the streams of a whole shot (their groups say `streams` too)
 * @returns {object|null} the track; `null` when no layer is on it
 */
export function buildPenetrationTrack({ shotId, projectile = '', energy = null, groups = [], streams = [] } = {}) {
  const id = text(shotId);
  if (!id) return null;
  const clean = (Array.isArray(groups) ? groups : []).map(sanitizeGroup).filter(Boolean).slice(0, MAX_GROUPS);
  if (!clean.length) return null;
  markFlightLosses(clean);

  let reference = num(energy);
  if (!(reference > EPS)) {
    for (const group of clean) {
      for (const stage of group.stages) {
        const entering = num(primaryItem(stage)?.eIn);
        if (entering > EPS) { reference = entering; break; }
      }
      if (reference > EPS) break;
    }
  }
  return pickDefined({
    v: PENETRATION_TRACK_VERSION,
    shotId: id,
    projectile: text(projectile),
    energy: reference > EPS ? round2(reference) : undefined,
    streams: cleanStreams(streams),
    groups: clean,
  });
}

/**
 * Assemble the track of one ray from what the shot met, in flight order: for every token the ray reached the
 * walls in front of it, then the body (armour, tissue); the walls the ray met that no token follows (the one
 * that stopped it, or walls it passed without reaching anything) come last.
 *
 * @param {Object} args
 * @param {string} args.shotId
 * @param {string} [args.projectile] name of the projectile
 * @param {number|null} [args.energy] muzzle energy (the reference of the percentages)
 * @param {Array<{
 *   title?: string,
 *   index?: number,
 *   img?: string,
 *   tokenId?: string,
 *   at?: {x: number, y: number},
 *   walls?: object[],
 *   scale?: number|null,
 *   quality?: string,
 *   pending?: boolean,
 *   bodies?: Array<{ result: object, names: object }>
 * }>} args.hits tokens reached, in flight order; `walls` are the `planWallPasses` events met on the way to it,
 *   `bodies` the `applyDamagePackage` results (several when a blast hit several parts) with the names of the
 *   body, `scale`/`quality` how much of the projectile's energy reached it and why less; `index` the place of
 *   the hit among the ray's impacts, `img` / `tokenId` / `at` the target's picture and where it was hit;
 *   `lanes` the ray ids of the pellets of a volley that wounded the target together (the items of the damage
 *   were labelled with their place in this list), `parallel` the hit is no continuation of the one before it
 * @param {object[]} [args.walls] every wall event of the ray (`shot.wallPasses`)
 * @param {{materialName?: (slug: string) => string}} [args.names] naming of walls
 * @returns {object|null}
 */
export function assembleRayTrack({ shotId, projectile = '', energy = null, hits = [], walls = [], names = {} } = {}) {
  const groups = [];
  const used = new Set();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const before = Array.isArray(hit?.walls) ? hit.walls : [];
    for (const event of before) used.add(event);
    const stages = wallStages(before, names);
    if (stages.length) groups.push({ kind: 'wall', at: before[0]?.entryPoint, stages });

    const bodies = (Array.isArray(hit?.bodies) ? hit.bodies : []).flatMap((body) => bodyGroups(body.result, { ...body.names, target: body.names?.target ?? hit.title }));
    const [first] = bodies;
    if (first && num(hit.scale) !== null) {
      first.scale = hit.scale;
      first.quality = hit.quality;
    }
    const lanes = Array.isArray(hit?.lanes) ? hit.lanes.filter(Boolean).slice(0, MAX_LANES) : [];
    const where = {
      hit: hit?.index,
      img: hit?.img,
      tokenId: hit?.tokenId,
      at: hit?.at,
      parallel: hit?.parallel === true ? true : undefined,
      ...(lanes.length > 1 ? { lanes: lanes.length, rays: lanes } : {}),
    };
    for (const body of bodies) Object.assign(body, where);
    groups.push(...bodies);
    if (!bodies.length && hit?.pending) groups.push({ kind: 'body', title: hit.title, pending: true, ...where, stages: [] });
  }
  const stray = (Array.isArray(walls) ? walls : []).filter((event) => !used.has(event));
  const strayStages = wallStages(stray, names);
  if (strayStages.length) groups.push({ kind: 'wall', at: stray[0]?.entryPoint, stages: strayStages });
  return buildPenetrationTrack({ shotId, projectile, energy, groups });
}

/**
 * Validate a track read from a chat message flag (written by another client, so untrusted).
 * @param {unknown} raw
 * @returns {object|null} a clean track, or `null` if it is unusable
 */
export function sanitizePenetrationTrack(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== PENETRATION_TRACK_VERSION) return null;
  const id = text(raw.shotId);
  if (!id) return null;
  const clean = (Array.isArray(raw.groups) ? raw.groups : []).map(sanitizeGroup).filter(Boolean).slice(0, MAX_GROUPS);
  if (!clean.length) return null;
  return pickDefined({
    v: PENETRATION_TRACK_VERSION,
    shotId: id,
    projectile: text(raw.projectile),
    energy: num(raw.energy) > EPS ? round2(raw.energy) : undefined,
    streams: cleanStreams(raw.streams),
    groups: clean,
  });
}

/**
 * Every track of an attack log (`shots[].tracks[]`), validated.
 * @param {object} log AttackLog
 * @returns {object[]}
 */
export function collectPenetrationTracks(log) {
  const out = [];
  for (const shot of Array.isArray(log?.shots) ? log.shots : []) {
    for (const raw of Array.isArray(shot?.tracks) ? shot.tracks : []) {
      const track = sanitizePenetrationTrack(raw);
      if (track) out.push(track);
    }
  }
  return out;
}

/**
 * The rays of a shot entry (one trigger pull), in order: `{ id, track }` — the track is `null` for a ray that
 * went through nothing worth a record. The ids are the entry's `ids`; entries without them (the log of an
 * older version) are read from their tracks and trail records.
 * @param {object} entry ShotEntry
 * @returns {Array<{ id: string, track: object|null }>}
 */
export function entryRays(entry) {
  const tracks = new Map();
  for (const raw of Array.isArray(entry?.tracks) ? entry.tracks : []) {
    const track = sanitizePenetrationTrack(raw);
    if (track) tracks.set(track.shotId, track);
  }
  return entryRayIds(entry).map((id) => ({ id, track: tracks.get(id) ?? null }));
}

/**
 * The ray ids of a shot entry, in the order of {@link entryRays}, without validating its tracks (for a button
 * or a lookup that needs only the ids).
 * @param {object} entry ShotEntry
 * @returns {string[]}
 */
export function entryRayIds(entry) {
  const ids = [];
  const add = (raw) => {
    const id = text(raw).replace(/\.x$/, '');
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const id of Array.isArray(entry?.ids) ? entry.ids : []) add(id);
  for (const raw of Array.isArray(entry?.tracks) ? entry.tracks : []) {
    if (raw && typeof raw === 'object' && raw.v === PENETRATION_TRACK_VERSION) add(raw.shotId);
  }
  for (const record of Array.isArray(entry?.records) ? entry.records : []) add(record?.id);
  return ids;
}

/**
 * The shot entry a ray belongs to, among attack logs.
 * @param {object[]} logs raw AttackLogs
 * @param {string} shotId id of a ray (`shot_…`)
 * @returns {{ log: object, entry: object }|null}
 */
export function findTrackEntry(logs, shotId) {
  const wanted = text(shotId);
  if (!wanted) return null;
  for (const log of Array.isArray(logs) ? logs : []) {
    for (const entry of Array.isArray(log?.shots) ? log.shots : []) {
      if (entryRayIds(entry).includes(wanted)) return { log, entry };
    }
  }
  return null;
}

/**
 * The share of the muzzle energy an amount is, in whole percent. `null` when the reference is unknown.
 * @param {unknown} value
 * @param {number|null|undefined} energy reference
 */
export function energyPercent(value, energy) {
  const v = num(value);
  const ref = num(energy);
  if (v === null || ref === null || ref <= EPS) return null;
  return Math.round((v / ref) * 100);
}
