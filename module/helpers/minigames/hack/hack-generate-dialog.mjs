/**
 * Generate-dialog entry for the hacking minigame.
 */

import {
  DEFAULT_HACK_ACTION_LIMIT,
  DEFAULT_HACK_COLS,
  DEFAULT_HACK_ROWS,
  generateHackSession,
  randomHackSeed,
} from './hack-generator.mjs';
import { postHackInviteToChat } from './hack-chat.mjs';
import { openHackMinigameApp } from './hack-minigame-app.mjs';
import {
  HACK_VISION_AVAILABLE,
  HACK_VISION_NEIGHBORS,
  HACK_VISION_OFF,
  normalizeVisionMode,
} from './hack-vision.mjs';

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * Read generate-dialog form values.
 * @param {ParentNode|null|undefined} root
 */
function readGenerateForm(root, ids) {
  const seed = String(root?.querySelector?.(`#${ids.seed}`)?.value ?? '').trim() || randomHackSeed();
  const rows = Number(root?.querySelector?.(`#${ids.rows}`)?.value) || DEFAULT_HACK_ROWS;
  const cols = Number(root?.querySelector?.(`#${ids.cols}`)?.value) || DEFAULT_HACK_COLS;
  const actionLimit = Number(root?.querySelector?.(`#${ids.limit}`)?.value) || DEFAULT_HACK_ACTION_LIMIT;
  const antivirus = !!root?.querySelector?.(`#${ids.av}`)?.checked;
  const bonuses = !!root?.querySelector?.(`#${ids.bn}`)?.checked;
  const visionMode = normalizeVisionMode(root?.querySelector?.(`#${ids.vi}`)?.value);
  return { seed, rows, cols, actionLimit, antivirus, bonuses, visionMode };
}

/**
 * Open generate dialog, then the minigame app (or post invite to chat).
 * @returns {Promise<{ ok: boolean, posted?: boolean }>}
 */
export async function openHackGenerateDialog() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    ui.notifications?.warn?.(L('SPACEHOLDER.HackMinigame.Messages.DialogUnavailable', 'Dialog API unavailable.'));
    return { ok: false };
  }

  const uid = foundry.utils.randomID?.() ?? `sh-hack-${Date.now()}`;
  const ids = {
    seed: `sh-hack-seed-${uid}`,
    rows: `sh-hack-rows-${uid}`,
    cols: `sh-hack-cols-${uid}`,
    limit: `sh-hack-limit-${uid}`,
    random: `sh-hack-random-${uid}`,
    av: `sh-hack-av-${uid}`,
    bn: `sh-hack-bn-${uid}`,
    vi: `sh-hack-vi-${uid}`,
  };

  const title = L('SPACEHOLDER.HackMinigame.Generate.Title', 'Hack minigame');
  const lblSeed = L('SPACEHOLDER.HackMinigame.Generate.Seed', 'Seed');
  const lblRows = L('SPACEHOLDER.HackMinigame.Generate.Rows', 'Rows');
  const lblCols = L('SPACEHOLDER.HackMinigame.Generate.Cols', 'Columns');
  const lblLimit = L('SPACEHOLDER.HackMinigame.Generate.ActionLimit', 'Action limit');
  const lblAv = L('SPACEHOLDER.HackMinigame.Generate.Antivirus', 'Antivirus');
  const lblBn = L('SPACEHOLDER.HackMinigame.Generate.Bonuses', 'Bonuses');
  const lblVi = L('SPACEHOLDER.HackMinigame.Generate.Vision', 'Vision');
  const lblViOff = L('SPACEHOLDER.HackMinigame.Generate.VisionOff', 'Off');
  const lblViNeighbors = L('SPACEHOLDER.HackMinigame.Generate.VisionNeighbors', 'Neighbors');
  const lblViAvailable = L('SPACEHOLDER.HackMinigame.Generate.VisionAvailable', 'Available only');
  const randomLabel = L('SPACEHOLDER.HackMinigame.Generate.RandomSeed', 'Random');
  const startLabel = L('SPACEHOLDER.HackMinigame.Generate.Start', 'Start');
  const toChatLabel = L('SPACEHOLDER.HackMinigame.Generate.ToChat', 'Send to chat');
  const cancelLabel = L('SPACEHOLDER.Actions.Cancel', 'Cancel');

  const initialSeed = randomHackSeed();
  const esc = (s) => foundry.utils.escapeHTML(String(s));

  const content = `
    <div class="spaceholder-hack-generate">
      <div class="form-group">
        <label for="${ids.seed}">${esc(lblSeed)}</label>
        <div class="spaceholder-hack-generate__seed-row">
          <input id="${ids.seed}" type="text" value="${esc(initialSeed)}" />
          <button type="button" id="${ids.random}" class="spaceholder-hack-generate__random">
            <i class="fa-solid fa-dice" aria-hidden="true"></i>
            <span>${esc(randomLabel)}</span>
          </button>
        </div>
      </div>
      <div class="form-group spaceholder-hack-generate__size">
        <label for="${ids.rows}">${esc(lblRows)}</label>
        <input id="${ids.rows}" type="number" min="3" max="16" step="1" value="${DEFAULT_HACK_ROWS}" />
        <label for="${ids.cols}">${esc(lblCols)}</label>
        <input id="${ids.cols}" type="number" min="3" max="20" step="1" value="${DEFAULT_HACK_COLS}" />
      </div>
      <div class="form-group">
        <label for="${ids.limit}">${esc(lblLimit)}</label>
        <input id="${ids.limit}" type="number" min="1" max="999" step="1" value="${DEFAULT_HACK_ACTION_LIMIT}" />
      </div>
      <div class="form-group spaceholder-hack-generate__toggles">
        <label class="spaceholder-hack-generate__check">
          <input id="${ids.av}" type="checkbox" checked />
          <span>${esc(lblAv)}</span>
        </label>
        <label class="spaceholder-hack-generate__check">
          <input id="${ids.bn}" type="checkbox" checked />
          <span>${esc(lblBn)}</span>
        </label>
      </div>
      <div class="form-group spaceholder-hack-generate__vision">
        <label for="${ids.vi}">${esc(lblVi)}</label>
        <select id="${ids.vi}">
          <option value="${HACK_VISION_OFF}">${esc(lblViOff)}</option>
          <option value="${HACK_VISION_NEIGHBORS}">${esc(lblViNeighbors)}</option>
          <option value="${HACK_VISION_AVAILABLE}" selected>${esc(lblViAvailable)}</option>
        </select>
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
    classes: ['spaceholder', 'spaceholder-hack-generate-dialog'],
    window: {
      title,
      icon: 'fa-solid fa-laptop-code',
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
          const params = readGenerateForm(root, ids);
          const session = generateHackSession(params);
          openHackMinigameApp(session, { mode: 'local' });
          outcome = { ok: true };
        },
      },
      {
        action: 'toChat',
        label: toChatLabel,
        icon: 'fa-solid fa-comment',
        callback: async (dlgEvent) => {
          const root = _formRoot(dlgEvent);
          const params = readGenerateForm(root, ids);
          try {
            await postHackInviteToChat(params);
            ui.notifications?.info?.(
              L('SPACEHOLDER.HackMinigame.Messages.PostedToChat', 'Hack minigame posted to chat.')
            );
            outcome = { ok: true, posted: true };
          } catch (err) {
            console.error('SpaceHolder | Failed to post hack invite:', err);
            ui.notifications?.error?.(
              L('SPACEHOLDER.HackMinigame.Messages.PostFailed', 'Failed to post hack minigame to chat.')
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

  const bindRandom = () => {
    const seedInput = document.getElementById(ids.seed);
    const btn = document.getElementById(ids.random);
    if (!btn || !seedInput) return false;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      seedInput.value = randomHackSeed();
    });
    return true;
  };
  queueMicrotask(() => {
    if (!bindRandom()) setTimeout(bindRandom, 50);
  });

  await waitPromise;
  return outcome ?? { ok: false };
}
