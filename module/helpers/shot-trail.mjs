/**
 * Shot trails: the serializable record of a shot and the fade curve of its drawn trail.
 *
 * A `ShotRecord` is the plain-JSON form of a shot's geometry (paths, hit marks, penetrated walls).
 * `ShotManager` builds one per shot; it is drawn at once on the shooter's client and sent to the other
 * clients over the socket (`DrawManager#broadcastRecord`). It is also kept in the attack log
 * (`weapon/attack-log.mjs`) that lands in chat when the aiming mode is left — a standalone message
 * (`flags.spaceholder.attackLog`) or a row of the combat action journal (`flags.spaceholder.actionJournal`)
 * — so a client rebuilds the fresh trails from the chat log after a reload or a scene change.
 *
 * Pure data and maths — no PIXI, no Foundry documents — so it runs in plain Node
 * (`node module/helpers/shot-trail.test.mjs`).
 */

export const SHOT_RECORD_VERSION = 1;

/** Chat message flag of a lone record (older messages): `message.flags.spaceholder.shot`. */
export const SHOT_FLAG_SCOPE = 'spaceholder';
export const SHOT_FLAG_KEY = 'shot';
/** Chat message flag of a standalone attack message: `message.flags.spaceholder.attackLog` (an AttackLog). */
export const ATTACK_LOG_FLAG_KEY = 'attackLog';
/** Chat message flag of a combat action journal: `message.flags.spaceholder.actionJournal.lines[]`. */
export const ACTION_JOURNAL_FLAG_KEY = 'actionJournal';
/** Socket message type that carries a freshly fired shot's record to the other clients. */
export const SHOT_TRAIL_SOCKET_TYPE = 'spaceholder.shotTrail';

export const SHOT_TRAIL_FADE_SETTING_KEY = 'shotTrailFadeSeconds';
export const DEFAULT_SHOT_TRAIL_FADE_SECONDS = 60;
export const MIN_SHOT_TRAIL_FADE_SECONDS = 5;
export const MAX_SHOT_TRAIL_FADE_SECONDS = 600;

/** Brightness a trail settles at after the opening hold, before it fades out linearly. */
const AGED_ALPHA = 0.55;
/** Share of the lifetime a trail stays at full brightness. */
const HOLD_FRACTION = 0.05;
/** Share of the lifetime spent easing from full brightness down to `AGED_ALPHA`. */
const SETTLE_FRACTION = 0.1;

const MAX_PATHS = 64;
const MAX_HITS = 64;
const MAX_WALL_PASSES = 16;
/** AoE coverage samples kept per hit (a token yields up to ~60). */
const MAX_HIT_POINTS = 32;
const COORD_LIMIT = 1e6;

const PATH_TYPES = new Set(['line', 'circle', 'cone', 'swing', 'swingFan', 'legacySwing']);
const CONE_TYPES = new Set(['cone', 'swing', 'swingFan', 'legacySwing']);
const PATH_NUMBER_FIELDS = ['range', 'angle', 'direction', 'cut', 'edgeDeg'];

/** Unique shot id (also the record id), safe across clients. */
export function makeShotId() {
  const random = globalThis.foundry?.utils?.randomID;
  const part = typeof random === 'function' ? random(16) : Math.random().toString(36).slice(2, 18);
  return `shot_${part}`;
}

/**
 * Epoch time (ms) a trail is stamped and aged by. Deliberately not `game.time.serverTime`: that is the
 * server's *uptime*, which restarts from zero with the server — a trail stamped before a restart then
 * looked brand new (negative age) and stayed at full brightness.
 */
export function trailNowMs() {
  return Date.now();
}

/** Smallest `t` that is an epoch time (2001-09-09). Smaller stamps are server uptimes of earlier versions. */
const MIN_EPOCH_MS = 1e12;

/* -------------------------------------------- */
/*  Fade curve                                  */
/* -------------------------------------------- */

/** Client setting value (seconds) → lifetime in ms, clamped to the supported range. */
export function shotTrailFadeMs(seconds) {
  const n = Number(seconds);
  const value = Number.isFinite(n) && n > 0 ? n : DEFAULT_SHOT_TRAIL_FADE_SECONDS;
  return Math.min(MAX_SHOT_TRAIL_FADE_SECONDS, Math.max(MIN_SHOT_TRAIL_FADE_SECONDS, value)) * 1000;
}

/**
 * Brightness (0–1) of a trail `ageMs` after the shot: a short hold at full brightness, a smooth
 * settle to `AGED_ALPHA`, then a linear fade to nothing at `fadeMs`. Depends only on age, never on
 * what the shooter is doing now.
 * @param {number} ageMs
 * @param {number} [fadeMs]
 * @returns {number}
 */
export function shotTrailAlpha(ageMs, fadeMs = DEFAULT_SHOT_TRAIL_FADE_SECONDS * 1000) {
  const age = Number(ageMs);
  const total = Math.max(1, Number(fadeMs) || 0);
  const hold = total * HOLD_FRACTION;
  if (!Number.isFinite(age) || age <= hold) return 1;
  if (age >= total) return 0;
  const settleEnd = hold + total * SETTLE_FRACTION;
  if (age < settleEnd) {
    const k = (age - hold) / (settleEnd - hold);
    const eased = k * k * (3 - 2 * k);
    return 1 + (AGED_ALPHA - 1) * eased;
  }
  return AGED_ALPHA * ((total - age) / (total - settleEnd));
}

/* -------------------------------------------- */
/*  Line chaining                               */
/* -------------------------------------------- */

/** Gap (px) between where a line ends and the next starts that still reads as one continuous trail. */
const CHAIN_JOIN_TOLERANCE_PX = 1.5;

/**
 * Prepare a record's paths for drawing: every `line` becomes a polyline (`points`), and lines that
 * pick up where the previous one ended (a ricochet leg) are merged into it, so a bouncing beam is one
 * continuous line and not a set of segments with a mark at every joint. Other paths pass through.
 * The input is not modified.
 *
 * @param {object[]} paths sanitized or raw record paths
 * @returns {object[]}
 */
export function chainLinePaths(paths) {
  const out = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    const isLine = path?.type === 'line' && path.start && path.end;
    if (!isLine) {
      out.push(path);
      continue;
    }
    const prev = out[out.length - 1];
    const tail = prev?.type === 'line' ? prev.points?.[prev.points.length - 1] : null;
    if (tail && Math.hypot(path.start.x - tail.x, path.start.y - tail.y) <= CHAIN_JOIN_TOLERANCE_PX) {
      prev.points.push({ x: path.end.x, y: path.end.y });
    } else {
      out.push({ ...path, points: [{ x: path.start.x, y: path.start.y }, { x: path.end.x, y: path.end.y }] });
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Record building / validation                */
/* -------------------------------------------- */

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Number rounded to 0.1 and bounded, for coordinates and angles. */
function toCoord(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return Math.round(Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, n)) * 10) / 10;
}

function toPoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = toCoord(raw.x);
  const y = toCoord(raw.y);
  return x === null || y === null ? null : { x, y };
}

function sampleEvenly(items, max) {
  if (items.length <= max) return items;
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor((i * items.length) / max)]);
  return out;
}

/**
 * One drawable path of a shot, reduced to the fields the renderer reads.
 * @returns {object|null} `null` when it is not drawable
 */
export function sanitizeShotPath(raw) {
  if (!raw || typeof raw !== 'object' || !PATH_TYPES.has(raw.type)) return null;
  const start = toPoint(raw.start);
  if (!start) return null;
  const path = { type: raw.type, start };
  const end = toPoint(raw.end);
  if (end) path.end = end;
  for (const field of PATH_NUMBER_FIELDS) {
    const n = toCoord(raw[field]);
    if (n !== null) path[field] = n;
  }
  const side = String(raw.side ?? '').toLowerCase();
  if (side === 'left' || side === 'right') path.side = side;

  if (path.type === 'line' && !path.end) return null;
  if (path.type === 'circle' && !(path.range > 0)) return null;
  if (CONE_TYPES.has(path.type)
    && (!(path.range > 0) || path.angle === undefined || path.direction === undefined)) return null;
  return path;
}

/**
 * A hit mark: where it landed, whether a token or a wall, and the AoE coverage samples if any.
 * Live objects (`object`) and combat details are dropped.
 * @returns {object|null}
 */
export function sanitizeShotHit(raw) {
  const point = toPoint(raw?.point);
  if (!point) return null;
  const hit = { point };
  if (raw.type === 'token' || raw.type === 'wall') hit.type = raw.type;
  if (Array.isArray(raw.hitPoints) && raw.hitPoints.length) {
    const samples = sampleEvenly(raw.hitPoints.map(toPoint).filter(Boolean), MAX_HIT_POINTS);
    if (samples.length) hit.hitPoints = samples;
  }
  return hit;
}

/** A wall the projectile went through (walls that stopped it are ordinary hits). */
export function sanitizeWallPass(raw) {
  if (!raw?.penetrated) return null;
  const entryPoint = toPoint(raw.entryPoint);
  if (!entryPoint) return null;
  const pass = { entryPoint, penetrated: true };
  const exitPoint = toPoint(raw.exitPoint);
  if (exitPoint) pass.exitPoint = exitPoint;
  return pass;
}

function sanitizeList(list, sanitize, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const clean = sanitize(item);
    if (clean) out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function stringOrNull(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

/**
 * Build the record of a registered shot (`ShotSystem` entry).
 * @param {{uid: string, shotResult: object}} shot
 * @param {{t?: number, sceneId?: string, tokenId?: string, userId?: string}} [meta]
 * @returns {object} ShotRecord
 */
export function buildShotRecord(shot, meta = {}) {
  const result = shot?.shotResult ?? {};
  const record = {
    v: SHOT_RECORD_VERSION,
    id: stringOrNull(shot?.uid) ?? makeShotId(),
    t: toNumber(meta.t) ?? trailNowMs(),
  };
  const sceneId = stringOrNull(meta.sceneId);
  const tokenId = stringOrNull(meta.tokenId);
  const userId = stringOrNull(meta.userId);
  if (sceneId) record.sceneId = sceneId;
  if (tokenId) record.tokenId = tokenId;
  if (userId) record.userId = userId;
  record.paths = sanitizeList(result.shotPaths, sanitizeShotPath, MAX_PATHS);
  record.hits = sanitizeList(result.shotHits, sanitizeShotHit, MAX_HITS);
  record.wallPasses = sanitizeList(result.wallPasses, sanitizeWallPass, MAX_WALL_PASSES);
  return record;
}

/**
 * Validate a record read from a chat message flag (written by another client, so untrusted).
 * @param {unknown} raw
 * @returns {object|null} a clean ShotRecord, or `null` if it is unusable
 */
export function sanitizeShotRecord(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== SHOT_RECORD_VERSION) return null;
  const id = stringOrNull(raw.id);
  const t = toNumber(raw.t);
  if (!id || t === null || t < MIN_EPOCH_MS) return null;
  const paths = sanitizeList(raw.paths, sanitizeShotPath, MAX_PATHS);
  if (!paths.length) return null;

  const record = { v: SHOT_RECORD_VERSION, id, t };
  const sceneId = stringOrNull(raw.sceneId);
  const tokenId = stringOrNull(raw.tokenId);
  const userId = stringOrNull(raw.userId);
  if (sceneId) record.sceneId = sceneId;
  if (tokenId) record.tokenId = tokenId;
  if (userId) record.userId = userId;
  record.paths = paths;
  record.hits = sanitizeList(raw.hits, sanitizeShotHit, MAX_HITS);
  record.wallPasses = sanitizeList(raw.wallPasses, sanitizeWallPass, MAX_WALL_PASSES);
  if (raw.quiet === true) record.quiet = true;
  return record;
}

/**
 * The attack logs a chat message carries: that of a standalone attack message, and the attack rows of a combat
 * action journal (also those nested as reactions). Not validated — the caller reads what it needs from them.
 * @param {object} message ChatMessage (or anything with `flags`)
 * @returns {object[]} raw AttackLogs
 */
export function readAttackLogs(message) {
  const flags = message?.flags?.[SHOT_FLAG_SCOPE];
  if (!flags || typeof flags !== 'object') return [];

  const logs = [flags[ATTACK_LOG_FLAG_KEY]];
  const lines = flags[ACTION_JOURNAL_FLAG_KEY]?.lines;
  for (const line of Array.isArray(lines) ? lines : []) {
    logs.push(line?.attack);
    for (const segment of Array.isArray(line?.segments) ? line.segments : []) {
      for (const reaction of Array.isArray(segment?.reactions) ? segment.reactions : []) logs.push(reaction?.attack);
    }
  }
  return logs.filter((log) => log && typeof log === 'object');
}

/**
 * Every shot record a chat message carries: the attack log of a standalone attack message, the attack
 * rows of a combat action journal (also those nested as reactions), or a lone record. Validated.
 * @param {object} message ChatMessage (or anything with `flags`)
 * @returns {object[]} clean ShotRecords
 */
export function readShotRecords(message) {
  const flags = message?.flags?.[SHOT_FLAG_SCOPE];
  if (!flags || typeof flags !== 'object') return [];

  const logs = readAttackLogs(message);
  const records = [];
  const lone = sanitizeShotRecord(flags[SHOT_FLAG_KEY]);
  if (lone) records.push(lone);
  for (const log of logs) {
    for (const shot of Array.isArray(log?.shots) ? log.shots : []) {
      for (const raw of Array.isArray(shot?.records) ? shot.records : []) {
        const record = sanitizeShotRecord(raw);
        if (record) records.push(record);
      }
    }
  }
  return records;
}

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

/** Register the trail settings (call from `init`). */
export function registerShotTrailSettings() {
  game.settings.register(SHOT_FLAG_SCOPE, SHOT_TRAIL_FADE_SETTING_KEY, {
    name: 'SPACEHOLDER.Settings.ShotTrailFade.Name',
    hint: 'SPACEHOLDER.Settings.ShotTrailFade.Hint',
    scope: 'client',
    config: true,
    type: Number,
    range: { min: MIN_SHOT_TRAIL_FADE_SECONDS, max: MAX_SHOT_TRAIL_FADE_SECONDS, step: 5 },
    default: DEFAULT_SHOT_TRAIL_FADE_SECONDS,
    onChange: () => game.spaceholder?.drawManager?.applyFadeSetting?.(),
  });
}

/** Current trail lifetime setting in seconds. */
export function getShotTrailFadeSeconds() {
  try {
    const value = Number(game.settings.get(SHOT_FLAG_SCOPE, SHOT_TRAIL_FADE_SETTING_KEY));
    return Number.isFinite(value) ? value : DEFAULT_SHOT_TRAIL_FADE_SECONDS;
  } catch (_) {
    return DEFAULT_SHOT_TRAIL_FADE_SECONDS;
  }
}
