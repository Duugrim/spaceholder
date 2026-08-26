/**
 * Generate-dialog entry for the lockpick minigame.
 */

import {
  DEFAULT_LOCKPICK_FAIL_JUMP_MAX,
  DEFAULT_LOCKPICK_HP,
  DEFAULT_LOCKPICK_NOISE_CHANCE,
  DEFAULT_LOCKPICK_PINS,
  DEFAULT_LOCKPICK_SEGMENT_DEG,
  DEFAULT_LOCKPICK_TMAX,
  DEFAULT_LOCKPICK_TMIN,
  DEFAULT_SOUND_SLOTS,
  DEFAULT_SOUND_VOLUMES,
  LOCKPICK_SEGMENT_OPTIONS,
  LOCKPICK_SOUND_IDS,
  generateLockpickSession,
  normalizeLockpickParams,
  randomLockpickSeed,
} from './lockpick-generator.mjs';
import { playLockpickSlot } from './lockpick-audio.mjs';
import { postLockpickInviteToChat } from './lockpick-chat.mjs';
import { openLockpickMinigameApp } from './lockpick-minigame-app.mjs';

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * @typedef {{ soundSlots: Record<string, string>, soundVolumes: Record<string, number> }} LockpickSoundConfig
 */

/**
 * @returns {LockpickSoundConfig}
 */
function defaultSoundConfig() {
  return {
    soundSlots: { ...DEFAULT_SOUND_SLOTS },
    soundVolumes: { ...DEFAULT_SOUND_VOLUMES },
  };
}

/**
 * @param {ParentNode|null|undefined} root
 * @param {Record<string, string>} ids
 * @param {LockpickSoundConfig} soundConfig
 */
function readGenerateForm(root, ids, soundConfig) {
  const seed = String(root?.querySelector?.(`#${ids.seed}`)?.value ?? '').trim() || randomLockpickSeed();
  const pinCount = Number(root?.querySelector?.(`#${ids.pins}`)?.value) || DEFAULT_LOCKPICK_PINS;
  const segmentDegrees = Number(root?.querySelector?.(`#${ids.seg}`)?.value) || DEFAULT_LOCKPICK_SEGMENT_DEG;
  const toleranceMin = Number(root?.querySelector?.(`#${ids.tmin}`)?.value);
  const toleranceMax = Number(root?.querySelector?.(`#${ids.tmax}`)?.value);
  const pinHpMax = Number(root?.querySelector?.(`#${ids.hp}`)?.value) || DEFAULT_LOCKPICK_HP;
  const failJumpEnabled = !!root?.querySelector?.(`#${ids.jump}`)?.checked;
  const failJumpMax = Number(root?.querySelector?.(`#${ids.jumpMax}`)?.value) || DEFAULT_LOCKPICK_FAIL_JUMP_MAX;
  const soundNoiseEnabled = !!root?.querySelector?.(`#${ids.noise}`)?.checked;
  let soundNoiseChance = Number(root?.querySelector?.(`#${ids.noisePct}`)?.value);
  if (!Number.isFinite(soundNoiseChance)) soundNoiseChance = DEFAULT_LOCKPICK_NOISE_CHANCE * 100;
  soundNoiseChance = Math.max(0, Math.min(100, soundNoiseChance)) / 100;

  return normalizeLockpickParams({
    seed,
    pinCount,
    segmentDegrees,
    toleranceMin: Number.isFinite(toleranceMin) ? toleranceMin : DEFAULT_LOCKPICK_TMIN,
    toleranceMax: Number.isFinite(toleranceMax) ? toleranceMax : DEFAULT_LOCKPICK_TMAX,
    pinHpMax,
    failJumpEnabled,
    failJumpMax,
    soundNoiseEnabled,
    soundNoiseChance,
    soundSlots: soundConfig.soundSlots,
    soundVolumes: soundConfig.soundVolumes,
  });
}

function _soundOptionsHtml(selected) {
  return LOCKPICK_SOUND_IDS.map((id) => {
    const sel = id === selected ? ' selected' : '';
    return `<option value="${id}"${sel}>${id}</option>`;
  }).join('');
}

/**
 * @param {ParentNode|null|undefined} root
 * @param {Record<string, string>} ids
 * @returns {LockpickSoundConfig}
 */
function readSoundForm(root, ids) {
  const soundSlots = {
    segmentHot: String(root?.querySelector?.(`#${ids.sndHot}`)?.value || DEFAULT_SOUND_SLOTS.segmentHot),
    segmentCold: String(root?.querySelector?.(`#${ids.sndCold}`)?.value || DEFAULT_SOUND_SLOTS.segmentCold),
    pinPassed: String(root?.querySelector?.(`#${ids.sndPass}`)?.value || DEFAULT_SOUND_SLOTS.pinPassed),
    pinReset: String(root?.querySelector?.(`#${ids.sndReset}`)?.value || DEFAULT_SOUND_SLOTS.pinReset),
  };

  const readVol = (id, fallback) => {
    let v = Number(root?.querySelector?.(`#${id}`)?.value);
    if (!Number.isFinite(v)) v = Math.round(fallback * 100);
    return Math.max(0, Math.min(200, v)) / 100;
  };
  const soundVolumes = {
    segmentCold: readVol(ids.volCold, DEFAULT_SOUND_VOLUMES.segmentCold),
    segmentHot: readVol(ids.volHot, DEFAULT_SOUND_VOLUMES.segmentHot),
    pinPassed: readVol(ids.volPass, DEFAULT_SOUND_VOLUMES.pinPassed),
    pinReset: readVol(ids.volReset, DEFAULT_SOUND_VOLUMES.pinReset),
  };

  return { soundSlots, soundVolumes };
}

/**
 * Nested dialog: sound file + volume per slot.
 * @param {LockpickSoundConfig} current
 * @returns {Promise<LockpickSoundConfig|null>}
 */
async function openLockpickSoundsDialog(current) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return null;

  const uid = foundry.utils.randomID?.() ?? `sh-lp-snd-${Date.now()}`;
  const ids = {
    sndHot: `sh-lp-snd-hot-${uid}`,
    sndCold: `sh-lp-snd-cold-${uid}`,
    sndPass: `sh-lp-snd-pass-${uid}`,
    sndReset: `sh-lp-snd-reset-${uid}`,
    volHot: `sh-lp-vol-hot-${uid}`,
    volCold: `sh-lp-vol-cold-${uid}`,
    volPass: `sh-lp-vol-pass-${uid}`,
    volReset: `sh-lp-vol-reset-${uid}`,
    previewCold: `sh-lp-preview-cold-${uid}`,
    previewHot: `sh-lp-preview-hot-${uid}`,
    previewPass: `sh-lp-preview-pass-${uid}`,
    previewReset: `sh-lp-preview-reset-${uid}`,
  };

  const esc = (s) => foundry.utils.escapeHTML(String(s));
  const title = L('SPACEHOLDER.LockpickMinigame.Generate.SoundsTitle', 'Sounds');
  const lblSndHot = L('SPACEHOLDER.LockpickMinigame.Generate.SoundHot', 'Hot segment');
  const lblSndCold = L('SPACEHOLDER.LockpickMinigame.Generate.SoundCold', 'Cold segment');
  const lblSndPass = L('SPACEHOLDER.LockpickMinigame.Generate.SoundPassed', 'Pin passed');
  const lblSndReset = L('SPACEHOLDER.LockpickMinigame.Generate.SoundReset', 'Pin reset');
  const lblVol = L('SPACEHOLDER.LockpickMinigame.Generate.VolumePct', 'Vol %');
  const lblPreview = L('SPACEHOLDER.LockpickMinigame.Generate.PreviewSound', 'Preview');
  const okLabel = L('SPACEHOLDER.LockpickMinigame.Generate.SoundsOk', 'OK');
  const cancelLabel = L('SPACEHOLDER.Actions.Cancel', 'Cancel');

  const slots = current.soundSlots;
  const vols = current.soundVolumes;

  const content = `
    <div class="spaceholder-lockpick-generate spaceholder-lockpick-generate--sounds">
      <div class="form-group spaceholder-lockpick-generate__sounds">
        <span class="spaceholder-lockpick-generate__sounds-head">${esc(lblSndCold)}</span>
        <select id="${ids.sndCold}">${_soundOptionsHtml(slots.segmentCold)}</select>
        <label class="spaceholder-lockpick-generate__vol-label" for="${ids.volCold}">${esc(lblVol)}</label>
        <input id="${ids.volCold}" type="number" min="0" max="200" step="5" value="${Math.round(vols.segmentCold * 100)}" />
        <button type="button" id="${ids.previewCold}" class="spaceholder-lockpick-generate__preview" aria-label="${esc(lblPreview)}">
          <i class="fa-solid fa-volume-high" aria-hidden="true"></i>
        </button>

        <span class="spaceholder-lockpick-generate__sounds-head">${esc(lblSndHot)}</span>
        <select id="${ids.sndHot}">${_soundOptionsHtml(slots.segmentHot)}</select>
        <label class="spaceholder-lockpick-generate__vol-label" for="${ids.volHot}">${esc(lblVol)}</label>
        <input id="${ids.volHot}" type="number" min="0" max="200" step="5" value="${Math.round(vols.segmentHot * 100)}" />
        <button type="button" id="${ids.previewHot}" class="spaceholder-lockpick-generate__preview" aria-label="${esc(lblPreview)}">
          <i class="fa-solid fa-volume-high" aria-hidden="true"></i>
        </button>

        <span class="spaceholder-lockpick-generate__sounds-head">${esc(lblSndPass)}</span>
        <select id="${ids.sndPass}">${_soundOptionsHtml(slots.pinPassed)}</select>
        <label class="spaceholder-lockpick-generate__vol-label" for="${ids.volPass}">${esc(lblVol)}</label>
        <input id="${ids.volPass}" type="number" min="0" max="200" step="5" value="${Math.round(vols.pinPassed * 100)}" />
        <button type="button" id="${ids.previewPass}" class="spaceholder-lockpick-generate__preview" aria-label="${esc(lblPreview)}">
          <i class="fa-solid fa-volume-high" aria-hidden="true"></i>
        </button>

        <span class="spaceholder-lockpick-generate__sounds-head">${esc(lblSndReset)}</span>
        <select id="${ids.sndReset}">${_soundOptionsHtml(slots.pinReset)}</select>
        <label class="spaceholder-lockpick-generate__vol-label" for="${ids.volReset}">${esc(lblVol)}</label>
        <input id="${ids.volReset}" type="number" min="0" max="200" step="5" value="${Math.round(vols.pinReset * 100)}" />
        <button type="button" id="${ids.previewReset}" class="spaceholder-lockpick-generate__preview" aria-label="${esc(lblPreview)}">
          <i class="fa-solid fa-volume-high" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;

  const _formRoot = (dlgEvent) =>
    dlgEvent?.currentTarget?.form ||
    dlgEvent?.target?.form ||
    dlgEvent?.currentTarget?.closest?.('form') ||
    dlgEvent?.target?.closest?.('form') ||
    dlgEvent?.currentTarget;

  /** @type {LockpickSoundConfig|null} */
  let result = null;

  const waitPromise = DialogV2.wait({
    classes: ['spaceholder', 'spaceholder-lockpick-generate-dialog', 'spaceholder-lockpick-sounds-dialog'],
    window: {
      title,
      icon: 'fa-solid fa-volume-high',
    },
    position: { width: 520 },
    content,
    buttons: [
      {
        action: 'ok',
        label: okLabel,
        icon: 'fa-solid fa-check',
        default: true,
        callback: (dlgEvent) => {
          result = readSoundForm(_formRoot(dlgEvent), ids);
        },
      },
      {
        action: 'cancel',
        label: cancelLabel,
        icon: 'fa-solid fa-xmark',
        callback: () => {
          result = null;
        },
      },
    ],
  });

  const bindPreviews = () => {
    /** @type {Array<{ slot: string, sndId: string, volId: string, previewId: string }>} */
    const previews = [
      { slot: 'segmentCold', sndId: ids.sndCold, volId: ids.volCold, previewId: ids.previewCold },
      { slot: 'segmentHot', sndId: ids.sndHot, volId: ids.volHot, previewId: ids.previewHot },
      { slot: 'pinPassed', sndId: ids.sndPass, volId: ids.volPass, previewId: ids.previewPass },
      { slot: 'pinReset', sndId: ids.sndReset, volId: ids.volReset, previewId: ids.previewReset },
    ];
    for (const row of previews) {
      const btn = document.getElementById(row.previewId);
      if (!btn) return false;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const soundId = String(document.getElementById(row.sndId)?.value || '');
        let volPct = Number(document.getElementById(row.volId)?.value);
        if (!Number.isFinite(volPct)) volPct = 100;
        volPct = Math.max(0, Math.min(200, volPct));
        const slotMap = {
          segmentCold: soundId,
          segmentHot: soundId,
          pinPassed: soundId,
          pinReset: soundId,
        };
        playLockpickSlot(/** @type {'segmentCold'|'segmentHot'|'pinPassed'|'pinReset'} */ (row.slot), slotMap, {
          volume: volPct / 100,
          pitchSpread: 0,
        });
      });
    }
    return true;
  };

  requestAnimationFrame(() => {
    if (!bindPreviews()) setTimeout(bindPreviews, 50);
  });

  await waitPromise;
  return result;
}

/**
 * @returns {Promise<{ ok: boolean, posted?: boolean }>}
 */
export async function openLockpickGenerateDialog() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    ui.notifications?.warn?.(
      L('SPACEHOLDER.LockpickMinigame.Messages.DialogUnavailable', 'Dialog API unavailable.')
    );
    return { ok: false };
  }

  const uid = foundry.utils.randomID?.() ?? `sh-lockpick-${Date.now()}`;
  const ids = {
    seed: `sh-lp-seed-${uid}`,
    random: `sh-lp-random-${uid}`,
    pins: `sh-lp-pins-${uid}`,
    seg: `sh-lp-seg-${uid}`,
    tmin: `sh-lp-tmin-${uid}`,
    tmax: `sh-lp-tmax-${uid}`,
    hp: `sh-lp-hp-${uid}`,
    jump: `sh-lp-jump-${uid}`,
    jumpMax: `sh-lp-jumpmax-${uid}`,
    noise: `sh-lp-noise-${uid}`,
    noisePct: `sh-lp-noisepct-${uid}`,
    sounds: `sh-lp-sounds-${uid}`,
  };

  /** @type {LockpickSoundConfig} */
  let soundConfig = defaultSoundConfig();

  const title = L('SPACEHOLDER.LockpickMinigame.Generate.Title', 'Lockpick minigame');
  const lblSeed = L('SPACEHOLDER.LockpickMinigame.Generate.Seed', 'Seed');
  const lblPins = L('SPACEHOLDER.LockpickMinigame.Generate.Pins', 'Pins');
  const lblSeg = L('SPACEHOLDER.LockpickMinigame.Generate.Segment', 'Segment (°)');
  const lblTmin = L('SPACEHOLDER.LockpickMinigame.Generate.ToleranceMin', 'Tolerance min');
  const lblTmax = L('SPACEHOLDER.LockpickMinigame.Generate.ToleranceMax', 'Tolerance max');
  const lblHp = L('SPACEHOLDER.LockpickMinigame.Generate.PinHp', 'Pin HP');
  const lblJump = L('SPACEHOLDER.LockpickMinigame.Generate.FailJump', 'Jump target on fail');
  const lblJumpMax = L('SPACEHOLDER.LockpickMinigame.Generate.FailJumpMax', 'Max jump');
  const lblNoise = L('SPACEHOLDER.LockpickMinigame.Generate.SoundNoise', 'Sound noise');
  const lblNoisePct = L('SPACEHOLDER.LockpickMinigame.Generate.SoundNoisePct', 'Noise %');
  const lblSounds = L('SPACEHOLDER.LockpickMinigame.Generate.SoundsButton', 'Sounds…');
  const randomLabel = L('SPACEHOLDER.LockpickMinigame.Generate.RandomSeed', 'Random');
  const startLabel = L('SPACEHOLDER.LockpickMinigame.Generate.Start', 'Start');
  const toChatLabel = L('SPACEHOLDER.LockpickMinigame.Generate.ToChat', 'Send to chat');
  const cancelLabel = L('SPACEHOLDER.Actions.Cancel', 'Cancel');

  const initialSeed = randomLockpickSeed();
  const esc = (s) => foundry.utils.escapeHTML(String(s));
  const segOpts = LOCKPICK_SEGMENT_OPTIONS.map((d) => {
    const sel = d === DEFAULT_LOCKPICK_SEGMENT_DEG ? ' selected' : '';
    return `<option value="${d}"${sel}>${d}</option>`;
  }).join('');

  const content = `
    <div class="spaceholder-lockpick-generate">
      <div class="form-group">
        <label for="${ids.seed}">${esc(lblSeed)}</label>
        <div class="spaceholder-lockpick-generate__seed-row">
          <input id="${ids.seed}" type="text" value="${esc(initialSeed)}" />
          <button type="button" id="${ids.random}" class="spaceholder-lockpick-generate__random">
            <i class="fa-solid fa-dice" aria-hidden="true"></i>
            <span>${esc(randomLabel)}</span>
          </button>
        </div>
      </div>
      <div class="form-group spaceholder-lockpick-generate__row">
        <label for="${ids.pins}">${esc(lblPins)}</label>
        <input id="${ids.pins}" type="number" min="1" max="20" step="1" value="${DEFAULT_LOCKPICK_PINS}" />
        <label for="${ids.seg}">${esc(lblSeg)}</label>
        <select id="${ids.seg}">${segOpts}</select>
      </div>
      <div class="form-group spaceholder-lockpick-generate__row">
        <label for="${ids.tmin}">${esc(lblTmin)}</label>
        <input id="${ids.tmin}" type="number" min="0" max="50" step="1" value="${DEFAULT_LOCKPICK_TMIN}" />
        <label for="${ids.tmax}">${esc(lblTmax)}</label>
        <input id="${ids.tmax}" type="number" min="0" max="50" step="1" value="${DEFAULT_LOCKPICK_TMAX}" />
      </div>
      <div class="form-group spaceholder-lockpick-generate__row">
        <label for="${ids.hp}">${esc(lblHp)}</label>
        <input id="${ids.hp}" type="number" min="1" max="20" step="1" value="${DEFAULT_LOCKPICK_HP}" />
      </div>
      <div class="form-group spaceholder-lockpick-generate__checks">
        <label><input id="${ids.jump}" type="checkbox" checked /> ${esc(lblJump)}</label>
        <label for="${ids.jumpMax}">${esc(lblJumpMax)}</label>
        <input id="${ids.jumpMax}" type="number" min="0" max="90" step="1" value="${DEFAULT_LOCKPICK_FAIL_JUMP_MAX}" />
      </div>
      <div class="form-group spaceholder-lockpick-generate__checks">
        <label><input id="${ids.noise}" type="checkbox" /> ${esc(lblNoise)}</label>
        <label for="${ids.noisePct}">${esc(lblNoisePct)}</label>
        <input id="${ids.noisePct}" type="number" min="0" max="100" step="1" value="${Math.round(DEFAULT_LOCKPICK_NOISE_CHANCE * 100)}" />
      </div>
      <div class="form-group spaceholder-lockpick-generate__sounds-entry">
        <button type="button" id="${ids.sounds}" class="spaceholder-lockpick-generate__sounds-btn">
          <i class="fa-solid fa-volume-high" aria-hidden="true"></i>
          <span>${esc(lblSounds)}</span>
        </button>
      </div>
    </div>`;

  const _formRoot = (dlgEvent) =>
    dlgEvent?.currentTarget?.form ||
    dlgEvent?.target?.form ||
    dlgEvent?.currentTarget?.closest?.('form') ||
    dlgEvent?.target?.closest?.('form') ||
    dlgEvent?.currentTarget;

  /** @type {{ ok: true, posted?: boolean } | { ok: false } | null} */
  let outcome = null;

  const waitPromise = DialogV2.wait({
    classes: ['spaceholder', 'spaceholder-lockpick-generate-dialog'],
    window: {
      title,
      icon: 'fa-solid fa-key',
    },
    position: { width: 420 },
    content,
    buttons: [
      {
        action: 'start',
        label: startLabel,
        icon: 'fa-solid fa-play',
        default: true,
        callback: (dlgEvent) => {
          const root = _formRoot(dlgEvent);
          const params = readGenerateForm(root, ids, soundConfig);
          if (!params) {
            outcome = { ok: false };
            return;
          }
          const session = generateLockpickSession(params);
          openLockpickMinigameApp(session, { mode: 'local' });
          outcome = { ok: true };
        },
      },
      {
        action: 'toChat',
        label: toChatLabel,
        icon: 'fa-solid fa-comment',
        callback: async (dlgEvent) => {
          const root = _formRoot(dlgEvent);
          const params = readGenerateForm(root, ids, soundConfig);
          try {
            await postLockpickInviteToChat(params);
            ui.notifications?.info?.(
              L('SPACEHOLDER.LockpickMinigame.Messages.PostedToChat', 'Lockpick minigame posted to chat.')
            );
            outcome = { ok: true, posted: true };
          } catch (err) {
            console.error('SpaceHolder | Failed to post lockpick invite:', err);
            ui.notifications?.error?.(
              L('SPACEHOLDER.LockpickMinigame.Messages.PostFailed', 'Failed to post lockpick minigame to chat.')
            );
            outcome = { ok: false };
          }
        },
      },
      {
        action: 'cancel',
        label: cancelLabel,
        icon: 'fa-solid fa-xmark',
        callback: () => {
          outcome = { ok: false };
        },
      },
    ],
  });

  const bindDialogControls = () => {
    const seedInput = document.getElementById(ids.seed);
    const randomBtn = document.getElementById(ids.random);
    const soundsBtn = document.getElementById(ids.sounds);
    if (!randomBtn || !seedInput || !soundsBtn) return false;

    randomBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      seedInput.value = randomLockpickSeed();
    });

    soundsBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = await openLockpickSoundsDialog(soundConfig);
      if (next) soundConfig = next;
    });

    return true;
  };

  requestAnimationFrame(() => {
    if (!bindDialogControls()) setTimeout(bindDialogControls, 50);
  });

  await waitPromise;
  return outcome || { ok: false };
}
