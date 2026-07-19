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
import { openHackMinigameApp } from './hack-minigame-app.mjs';

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * Open generate dialog, then the minigame app.
 * @returns {Promise<{ ok: boolean }>}
 */
export async function openHackGenerateDialog() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    ui.notifications?.warn?.(L('SPACEHOLDER.HackMinigame.Messages.DialogUnavailable', 'Dialog API unavailable.'));
    return { ok: false };
  }

  const uid = foundry.utils.randomID?.() ?? `sh-hack-${Date.now()}`;
  const idSeed = `sh-hack-seed-${uid}`;
  const idRows = `sh-hack-rows-${uid}`;
  const idCols = `sh-hack-cols-${uid}`;
  const idLimit = `sh-hack-limit-${uid}`;
  const idRandom = `sh-hack-random-${uid}`;
  const idAv = `sh-hack-av-${uid}`;
  const idBn = `sh-hack-bn-${uid}`;
  const idVi = `sh-hack-vi-${uid}`;

  const title = L('SPACEHOLDER.HackMinigame.Generate.Title', 'Hack minigame');
  const lblSeed = L('SPACEHOLDER.HackMinigame.Generate.Seed', 'Seed');
  const lblRows = L('SPACEHOLDER.HackMinigame.Generate.Rows', 'Rows');
  const lblCols = L('SPACEHOLDER.HackMinigame.Generate.Cols', 'Columns');
  const lblLimit = L('SPACEHOLDER.HackMinigame.Generate.ActionLimit', 'Action limit');
  const lblAv = L('SPACEHOLDER.HackMinigame.Generate.Antivirus', 'Antivirus');
  const lblBn = L('SPACEHOLDER.HackMinigame.Generate.Bonuses', 'Bonuses');
  const lblVi = L('SPACEHOLDER.HackMinigame.Generate.Vision', 'Vision');
  const randomLabel = L('SPACEHOLDER.HackMinigame.Generate.RandomSeed', 'Random');
  const startLabel = L('SPACEHOLDER.HackMinigame.Generate.Start', 'Start');
  const cancelLabel = L('SPACEHOLDER.Actions.Cancel', 'Cancel');

  const initialSeed = randomHackSeed();

  const content = `
    <div class="spaceholder-hack-generate">
      <div class="form-group">
        <label for="${idSeed}">${foundry.utils.escapeHTML(lblSeed)}</label>
        <div class="spaceholder-hack-generate__seed-row">
          <input id="${idSeed}" type="text" value="${foundry.utils.escapeHTML(initialSeed)}" />
          <button type="button" id="${idRandom}" class="spaceholder-hack-generate__random">
            <i class="fa-solid fa-dice" aria-hidden="true"></i>
            <span>${foundry.utils.escapeHTML(randomLabel)}</span>
          </button>
        </div>
      </div>
      <div class="form-group spaceholder-hack-generate__size">
        <label for="${idRows}">${foundry.utils.escapeHTML(lblRows)}</label>
        <input id="${idRows}" type="number" min="3" max="16" step="1" value="${DEFAULT_HACK_ROWS}" />
        <label for="${idCols}">${foundry.utils.escapeHTML(lblCols)}</label>
        <input id="${idCols}" type="number" min="3" max="20" step="1" value="${DEFAULT_HACK_COLS}" />
      </div>
      <div class="form-group">
        <label for="${idLimit}">${foundry.utils.escapeHTML(lblLimit)}</label>
        <input id="${idLimit}" type="number" min="1" max="999" step="1" value="${DEFAULT_HACK_ACTION_LIMIT}" />
      </div>
      <div class="form-group spaceholder-hack-generate__toggles">
        <label class="spaceholder-hack-generate__check">
          <input id="${idAv}" type="checkbox" checked />
          <span>${foundry.utils.escapeHTML(lblAv)}</span>
        </label>
        <label class="spaceholder-hack-generate__check">
          <input id="${idBn}" type="checkbox" checked />
          <span>${foundry.utils.escapeHTML(lblBn)}</span>
        </label>
        <label class="spaceholder-hack-generate__check">
          <input id="${idVi}" type="checkbox" checked />
          <span>${foundry.utils.escapeHTML(lblVi)}</span>
        </label>
      </div>
    </div>`;

  const _formRoot = (dlgEvent) =>
    dlgEvent?.currentTarget?.form ||
    dlgEvent?.target?.form ||
    dlgEvent?.currentTarget?.closest?.('form') ||
    dlgEvent?.target?.closest?.('form') ||
    dlgEvent?.currentTarget;

  /** @type {{ ok: true } | { ok: false } | null} */
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
          const seed = String(root?.querySelector?.(`#${idSeed}`)?.value ?? '').trim() || randomHackSeed();
          const rows = Number(root?.querySelector?.(`#${idRows}`)?.value) || DEFAULT_HACK_ROWS;
          const cols = Number(root?.querySelector?.(`#${idCols}`)?.value) || DEFAULT_HACK_COLS;
          const actionLimit = Number(root?.querySelector?.(`#${idLimit}`)?.value) || DEFAULT_HACK_ACTION_LIMIT;
          const antivirus = !!root?.querySelector?.(`#${idAv}`)?.checked;
          const bonuses = !!root?.querySelector?.(`#${idBn}`)?.checked;
          const vision = !!root?.querySelector?.(`#${idVi}`)?.checked;
          const session = generateHackSession({ seed, rows, cols, actionLimit, antivirus, bonuses, vision });
          openHackMinigameApp(session);
          outcome = { ok: true };
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
    const seedInput = document.getElementById(idSeed);
    const btn = document.getElementById(idRandom);
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
