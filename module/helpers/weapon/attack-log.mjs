/**
 * Attack log — the record of one attack: everything shot between the first trigger pull and leaving the
 * aiming mode. Pure data and maths (no Foundry globals), so it runs in plain Node
 * (`node module/helpers/weapon/attack-log.test.mjs`).
 *
 * The log is plain JSON: the aiming session fills it, then it is written once — as an expandable row in
 * the actor's combat action journal (in combat) or as a chat message of its own (otherwise). Rendering
 * lives in `actions/attack-journal.mjs`.
 *
 * Shape:
 * - `AttackLog`: `{ v, id, startedAt, endedAt, actorUuid, actorName, tokenUuid, tokenName, weaponUuid,
 *   weaponName, lineName, modeName, fireMode, shots: ShotEntry[] }`
 * - `ShotEntry`: one trigger pull — `{ n, at, apCost, baseApCost, rays, luck, spread, passes: string[],
 *   impacts: Impact[], ids: string[], records: ShotRecord[], tracks: PenetrationTrack[] }` — a
 *   multishot volley is several rays of one shot, `ids` their ids (`shot_…`; the penetration view opens by one
 *   of them); `records` are the rays' trails (`shot-trail.mjs`), kept for redrawing;
 *   `tracks` are the rays' penetration tracks (`damage/penetration-track.mjs`: the layers the projectile went
 *   through and what became of its energy in each), keyed by the same shot id as the trail record
 * - `Impact`: one token the shot reached: `{ tokenUuid, name, kind: 'line'|'area', outcome:
 *   'hit'|'area'|'pass', shotId, clock, centrality, energyScale, quality: 'crit'|'full'|'glancing', qualityLabel,
 *   crit, pickedGroup, coverage, coverageMode, effectScale, partName, organs: string[], damage: [{type, amount}],
 *   queued, failed, through, exit }` — a line hit carries the hit quality (`hit-quality.mjs`: how centrally the hitbox was met
 *   and the share of the projectile's energy that reached the target); `pass` is a projectile that flew
 *   past the token; `exit` is the damage of the bullet that left the target's body and flew on, `through`
 *   the name of the target it left before it reached this one (the impacts of a ray are in flight order).
 *   A ray's extra trail (the bullet that flew on) is one more record in `records`
 */

import { MAX_TRACKS_PER_LOG } from '../damage/penetration-track.mjs';

export const ATTACK_LOG_VERSION = 1;

/** Shot trails (rays) kept inside one log; later shots keep their results but not the drawing (size guard). */
export const MAX_RECORDED_TRAILS = 40;

/** Impact outcomes that count as the token being hit. */
const HIT_OUTCOMES = new Set(['hit', 'area']);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

/** Unique attack id, safe across clients. */
export function makeAttackId() {
  const random = globalThis.foundry?.utils?.randomID;
  const part = typeof random === 'function' ? random(16) : Math.random().toString(36).slice(2, 18);
  return `attack_${part}`;
}

/**
 * Start a log.
 * @param {object} meta
 * @param {number} [meta.startedAt] epoch ms
 * @param {{uuid?: string, name?: string}} [meta.actor]
 * @param {{uuid?: string, name?: string}} [meta.token]
 * @param {{uuid?: string, name?: string}} [meta.weapon]
 * @param {string} [meta.lineName]
 * @param {string} [meta.modeName]
 * @param {string} [meta.fireMode] single | burst | auto (empty for a payload shot with no weapon)
 * @returns {object} AttackLog
 */
export function createAttackLog(meta = {}) {
  return {
    v: ATTACK_LOG_VERSION,
    id: toText(meta.id) || makeAttackId(),
    startedAt: toNumber(meta.startedAt, Date.now()),
    endedAt: null,
    actorUuid: toText(meta.actor?.uuid) || null,
    actorName: toText(meta.actor?.name),
    tokenUuid: toText(meta.token?.uuid) || null,
    tokenName: toText(meta.token?.name),
    weaponUuid: toText(meta.weapon?.uuid) || null,
    weaponName: toText(meta.weapon?.name),
    lineName: toText(meta.lineName),
    modeName: toText(meta.modeName),
    fireMode: toText(meta.fireMode),
    shots: [],
  };
}

/**
 * Append a shot (one trigger pull). Numbers the shot, and drops the trail drawings that would take the
 * log past `MAX_RECORDED_TRAILS`.
 * @param {object} log AttackLog
 * @param {object} entry ShotEntry without `n`
 * @returns {object} the stored ShotEntry
 */
export function addShot(log, entry = {}) {
  const kept = collectAttackRecords(log).length;
  const keptTracks = collectAttackTracks(log).length;
  const records = (Array.isArray(entry.records) ? entry.records : []).filter(Boolean);
  const tracks = (Array.isArray(entry.tracks) ? entry.tracks : []).filter(Boolean);
  const shot = {
    n: log.shots.length + 1,
    at: toNumber(entry.at, Date.now()),
    apCost: Math.max(0, toNumber(entry.apCost)),
    baseApCost: Math.max(0, toNumber(entry.baseApCost, entry.apCost)),
    rays: Math.max(1, Math.floor(toNumber(entry.rays, 1))),
    luck: entry.luck ?? null,
    spread: entry.spread ?? null,
    passes: Array.isArray(entry.passes) ? entry.passes : [],
    impacts: Array.isArray(entry.impacts) ? entry.impacts : [],
    ids: (Array.isArray(entry.ids) ? entry.ids : []).filter((id) => typeof id === 'string' && id),
    records: records.slice(0, Math.max(0, MAX_RECORDED_TRAILS - kept)),
    tracks: tracks.slice(0, Math.max(0, MAX_TRACKS_PER_LOG - keptTracks)),
  };
  log.shots.push(shot);
  return shot;
}

/** Close the log. */
export function finishAttackLog(log, endedAt = Date.now()) {
  log.endedAt = toNumber(endedAt, Date.now());
  return log;
}

/**
 * Whether an impact is a token being hit (a glancing hit counts; a projectile that flew past does not).
 * @param {{outcome?: string}} impact
 */
export function isHitImpact(impact) {
  return HIT_OUTCOMES.has(String(impact?.outcome ?? ''));
}

/**
 * AP of the whole attack: what was charged and what it would have cost without the actor's action speed.
 * @param {object} log
 * @returns {{ ap: number, baseAp: number }}
 */
export function attackApTotals(log) {
  let ap = 0;
  let baseAp = 0;
  for (const shot of log?.shots ?? []) {
    ap += Math.max(0, toNumber(shot.apCost));
    baseAp += Math.max(0, toNumber(shot.baseApCost, shot.apCost));
  }
  return { ap, baseAp };
}

/**
 * Shots fired, token hits, shots that hit nothing.
 * @param {object} log
 * @returns {{ shots: number, hits: number, missedShots: number }}
 */
export function attackTotals(log) {
  let hits = 0;
  let missedShots = 0;
  const shots = log?.shots ?? [];
  for (const shot of shots) {
    const shotHits = (shot.impacts ?? []).filter(isHitImpact).length;
    hits += shotHits;
    if (!shotHits) missedShots += 1;
  }
  return { shots: shots.length, hits, missedShots };
}

/**
 * The summary: every token that was hit and how many times, in the order they were first hit. Walls are
 * not part of it. Each target lists its hits (`entries`) with the number of the shot that made them.
 * @param {object} log
 * @returns {Array<{ key: string, name: string, tokenUuid: string|null, hits: number, entries: Array<{ shot: number, impact: object }> }>}
 */
export function summarizeTargets(log) {
  const byKey = new Map();
  for (const shot of log?.shots ?? []) {
    for (const impact of shot.impacts ?? []) {
      if (!isHitImpact(impact)) continue;
      const key = toText(impact.tokenUuid) || toText(impact.name) || '?';
      let target = byKey.get(key);
      if (!target) {
        target = { key, name: toText(impact.name), tokenUuid: toText(impact.tokenUuid) || null, hits: 0, entries: [] };
        byKey.set(key, target);
      }
      target.hits += 1;
      target.entries.push({ shot: shot.n, impact });
    }
  }
  return [...byKey.values()];
}

/**
 * The shot trails stored in the log, oldest first (to redraw them).
 * @param {object} log
 * @returns {object[]}
 */
export function collectAttackRecords(log) {
  return (log?.shots ?? []).flatMap((shot) => (Array.isArray(shot.records) ? shot.records : [])).filter(Boolean);
}

/**
 * The penetration tracks stored in the log, oldest first (to open them by shot id).
 * @param {object} log
 * @returns {object[]}
 */
export function collectAttackTracks(log) {
  return (log?.shots ?? []).flatMap((shot) => (Array.isArray(shot.tracks) ? shot.tracks : [])).filter(Boolean);
}

/* -------------------------------------------- */
/*  Number formatting (log lines)               */
/* -------------------------------------------- */

/**
 * A number for a log line: two decimals at most, `?` when it is not a number.
 * @param {unknown} n
 * @returns {string}
 */
export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  return String(Math.round(v * 100) / 100);
}

/**
 * Clock hours (12 = the target's front) for a log line: wrapped into 0..12, one decimal at most.
 * @param {unknown} n
 * @returns {string}
 */
export function formatClock(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  const hours = ((v % 12) + 12) % 12;
  const r = Math.round(hours * 10) / 10;
  return r === 0 ? '12' : String(r);
}
