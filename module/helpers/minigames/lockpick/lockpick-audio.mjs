/**
 * Lockpick minigame audio: sound pool, slots, pitch variation.
 * Uses a preloaded HTMLAudioElement pool so every click actually plays
 * (raw `new Audio().play()` often fails silently before the buffer is ready).
 */

const SOUND_DIR = 'systems/spaceholder/assets/sounds/lockpick';

/** @type {readonly string[]} */
export const LOCKPICK_SOUND_IDS = Object.freeze([
  'metal-click1',
  'metal-click2',
  'metal-click3',
  'metal-click4',
  'metal-click5',
  'turn-on-click',
  'click-off',
  'lock-in-the-car',
  'the-sound-of-opening-the-central-lock',
  'deaf-short-sound-of-a-metal-object',
]);

export const DEFAULT_SOUND_SLOTS = Object.freeze({
  segmentCold: 'metal-click2',
  segmentHot: 'metal-click3',
  pinPassed: 'the-sound-of-opening-the-central-lock',
  pinReset: 'lock-in-the-car',
});

/** Per-slot gain 0..2 (UI shows 0–200%). HTMLAudio caps at 1; >1 uses WebAudio gain. */
export const DEFAULT_SOUND_VOLUMES = Object.freeze({
  segmentCold: 1.5,
  segmentHot: 1.5,
  pinPassed: 1,
  pinReset: 1,
});

/** @type {Map<string, HTMLAudioElement[]>} */
const _pools = new Map();
/** @type {Map<string, AudioBuffer>} */
const _buffers = new Map();
/** @type {AudioContext|null} */
let _audioCtx = null;
const POOL_SIZE = 4;
let _preloaded = false;

/**
 * @param {string} id
 */
export function soundPathForId(id) {
  const safe = LOCKPICK_SOUND_IDS.includes(id) ? id : DEFAULT_SOUND_SLOTS.segmentCold;
  return `${SOUND_DIR}/${safe}.mp3`;
}

/**
 * Absolute/routed src Foundry can fetch.
 * @param {string} path
 */
function _routedSrc(path) {
  try {
    if (typeof foundry !== 'undefined' && foundry?.utils?.getRoute) {
      return foundry.utils.getRoute(path);
    }
  } catch (_) {
    /* ignore */
  }
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * @param {object} [raw]
 */
export function normalizeSoundSlots(raw = {}) {
  const pick = (key, fallback) => {
    const v = String(raw?.[key] || fallback);
    return LOCKPICK_SOUND_IDS.includes(v) ? v : fallback;
  };
  return {
    segmentHot: pick('segmentHot', DEFAULT_SOUND_SLOTS.segmentHot),
    segmentCold: pick('segmentCold', DEFAULT_SOUND_SLOTS.segmentCold),
    pinPassed: pick('pinPassed', DEFAULT_SOUND_SLOTS.pinPassed),
    pinReset: pick('pinReset', DEFAULT_SOUND_SLOTS.pinReset),
  };
}

/**
 * @param {object} [raw]
 * @returns {{ segmentHot: number, segmentCold: number, pinPassed: number, pinReset: number }}
 */
export function normalizeSoundVolumes(raw = {}) {
  const clamp = (key, fallback) => {
    let v = Number(raw?.[key]);
    if (!Number.isFinite(v)) v = fallback;
    // Accept 0–200 as percent or 0–2 as gain
    if (v > 2) v = v / 100;
    return Math.max(0, Math.min(2, v));
  };
  return {
    segmentHot: clamp('segmentHot', DEFAULT_SOUND_VOLUMES.segmentHot),
    segmentCold: clamp('segmentCold', DEFAULT_SOUND_VOLUMES.segmentCold),
    pinPassed: clamp('pinPassed', DEFAULT_SOUND_VOLUMES.pinPassed),
    pinReset: clamp('pinReset', DEFAULT_SOUND_VOLUMES.pinReset),
  };
}

/**
 * @param {string} slot
 * @param {ReturnType<typeof normalizeSoundSlots>} slots
 */
export function resolveSlotSoundId(slot, slots) {
  const s = normalizeSoundSlots(slots);
  if (slot === 'segmentHot') return s.segmentHot;
  if (slot === 'segmentCold') return s.segmentCold;
  if (slot === 'pinPassed') return s.pinPassed;
  if (slot === 'pinReset') return s.pinReset;
  return s.segmentCold;
}

/**
 * @param {string} slot
 * @param {ReturnType<typeof normalizeSoundVolumes>} [volumes]
 */
export function resolveSlotVolume(slot, volumes) {
  const v = normalizeSoundVolumes(volumes);
  if (slot === 'segmentHot') return v.segmentHot;
  if (slot === 'segmentCold') return v.segmentCold;
  if (slot === 'pinPassed') return v.pinPassed;
  if (slot === 'pinReset') return v.pinReset;
  return v.segmentCold;
}

/**
 * Warm the pool so the first rotate is not silent.
 */
export function preloadLockpickSounds() {
  if (_preloaded) return;
  _preloaded = true;
  for (const id of LOCKPICK_SOUND_IDS) {
    _ensurePool(id);
  }
}

/**
 * @param {string} id
 * @returns {HTMLAudioElement[]}
 */
function _ensurePool(id) {
  let pool = _pools.get(id);
  if (pool?.length) return pool;
  pool = [];
  const src = _routedSrc(soundPathForId(id));
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const el = new Audio(src);
    el.preload = 'auto';
    el.volume = 0.55;
    try {
      el.load();
    } catch (_) {
      /* ignore */
    }
    pool.push(el);
  }
  _pools.set(id, pool);
  return pool;
}

/**
 * Next free (or oldest) element from the pool.
 * @param {string} id
 */
function _nextFromPool(id) {
  const pool = _ensurePool(id);
  let best = pool[0];
  for (const el of pool) {
    if (el.paused || el.ended || el.currentTime === 0) {
      best = el;
      break;
    }
    // Prefer the one furthest along (will restart soonest)
    if (el.currentTime >= (best.currentTime || 0)) best = el;
  }
  return best;
}

/**
 * Play a named slot with slight pitch jitter so repeats feel less mechanical.
 * @param {'segmentHot'|'segmentCold'|'pinPassed'|'pinReset'} slot
 * @param {object} [slots]
 * @param {{ mute?: boolean, pitchSpread?: number, volume?: number, volumes?: object }} [opts]
 */
export function playLockpickSlot(slot, slots = DEFAULT_SOUND_SLOTS, opts = {}) {
  if (opts.mute) return;
  preloadLockpickSounds();
  const id = resolveSlotSoundId(slot, slots);
  const spread = opts.pitchSpread != null ? opts.pitchSpread : 0.06;
  const pitch = 1 + (Math.random() * 2 - 1) * spread;
  const volume = opts.volume != null
    ? Math.max(0, Math.min(2, Number(opts.volume) || 0))
    : resolveSlotVolume(slot, opts.volumes);
  const src = _routedSrc(soundPathForId(id));

  if (volume > 1) {
    void _playViaWebAudio(id, src, volume, pitch);
    return;
  }

  const el = _nextFromPool(id);
  try {
    el.pause();
    el.currentTime = 0;
  } catch (_) {
    /* ignore seek errors before metadata */
  }
  el.volume = volume;
  try {
    el.playbackRate = Math.max(0.85, Math.min(1.15, pitch));
  } catch (_) {
    /* ignore */
  }

  const p = el.play();
  if (p?.catch) {
    p.catch((err) => {
      try {
        const Helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
        if (Helper?.play) {
          Helper.play({ src, volume: Math.min(1, volume), loop: false }, false);
          return;
        }
      } catch (_) {
        /* ignore */
      }
      console.warn('SpaceHolder | lockpick audio play failed', id, err);
    });
  }
}

/**
 * @returns {AudioContext}
 */
function _getAudioCtx() {
  if (_audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  _audioCtx = new Ctx();
  return _audioCtx;
}

/**
 * Boosted playback (volume > 1) via GainNode.
 * @param {string} id
 * @param {string} src
 * @param {number} volume
 * @param {number} pitch
 */
async function _playViaWebAudio(id, src, volume, pitch) {
  try {
    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    let buffer = _buffers.get(id);
    if (!buffer) {
      const res = await fetch(src);
      const arr = await res.arrayBuffer();
      buffer = await ctx.decodeAudioData(arr.slice(0));
      _buffers.set(id, buffer);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.85, Math.min(1.15, pitch));
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  } catch (err) {
    console.warn('SpaceHolder | lockpick webAudio failed', id, err);
    // Fallback to capped HTML volume
    const el = _nextFromPool(id);
    try {
      el.pause();
      el.currentTime = 0;
    } catch (_) {
      /* ignore */
    }
    el.volume = 1;
    void el.play()?.catch?.(() => {});
  }
}
