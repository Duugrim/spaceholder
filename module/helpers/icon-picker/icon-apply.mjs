// Icon apply helpers (SpaceHolder, Foundry v13)

import { pickIcon } from './icon-picker.mjs';

function _L(key) {
  try { return game.i18n.localize(key); } catch (_) { return key; }
}

function _normalizeApplyTo(raw) {
  const v = String(raw ?? '').trim();
  if (v === 'actor' || v === 'token' || v === 'both') return v;
  return null;
}

export async function promptIconApplyTarget() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return null;

  const title = _L('SPACEHOLDER.IconPicker.ApplyDialog.Title');
  const content = `<div class="sh-icon-apply">${_L('SPACEHOLDER.IconPicker.ApplyDialog.Hint')}</div>`;

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(_normalizeApplyTo(v));
    };

    const p = DialogV2.wait({
      window: { title, icon: 'fa-solid fa-icons' },
      position: { width: 420 },
      content,
      buttons: [
        {
          action: 'actor',
          label: _L('SPACEHOLDER.IconPicker.ApplyDialog.Actor'),
          icon: 'fa-solid fa-user',
          callback: () => { settle('actor'); return 'actor'; },
        },
        {
          action: 'token',
          label: _L('SPACEHOLDER.IconPicker.ApplyDialog.Token'),
          icon: 'fa-solid fa-circle-dot',
          callback: () => { settle('token'); return 'token'; },
        },
        {
          action: 'both',
          label: _L('SPACEHOLDER.IconPicker.ApplyDialog.Both'),
          icon: 'fa-solid fa-clone',
          callback: () => { settle('both'); return 'both'; },
        },
        {
          action: 'cancel',
          label: _L('SPACEHOLDER.Actions.Cancel'),
          icon: 'fa-solid fa-times',
          callback: () => { settle(null); return null; },
        },
      ],
    });

    // If the dialog is closed via the window X, Foundry should resolve the promise.
    if (p && typeof p.then === 'function') {
      p.then((r) => settle(r)).catch(() => settle(null));
    }
  });
}

export async function applyIconPathToActorOrToken({
  path,
  actor,
  tokenDoc = null,
  applyTo = 'actor',
} = {}) {
  const p = String(path ?? '').trim();
  if (!p) return false;

  const target = _normalizeApplyTo(applyTo);
  if (!target) return false;

  const updates = [];

  if (target === 'actor' || target === 'both') {
    if (actor?.update) {
      updates.push(actor.update({ img: p }));
    }
  }

  if (target === 'token' || target === 'both') {
    // If we have a TokenDocument context, update it; otherwise update prototype token.
    if (tokenDoc?.documentName === 'Token' && tokenDoc?.update) {
      updates.push(tokenDoc.update({ 'texture.src': p }));
    } else if (actor?.update) {
      updates.push(actor.update({ 'prototypeToken.texture.src': p }));
    }
  }

  await Promise.allSettled(updates);
  return true;
}

export async function pickAndApplyIconToActorOrToken({
  actor,
  tokenDoc = null,
  applyTo = 'actor',
  root = null,
  defaultColor = '#ffffff',
  title = null,
  factionColor = null,
} = {}) {
  const target = _normalizeApplyTo(applyTo);
  if (!target) return null;

  // Try to open the currently assigned icon for editing.
  let initialPath = null;
  try {
    if (target === 'token') {
      initialPath = String((tokenDoc?.texture?.src) ?? actor?.prototypeToken?.texture?.src ?? '').trim() || null;
    } else {
      initialPath = String(actor?.img ?? '').trim() || null;
    }
  } catch (_) {
    initialPath = null;
  }

  const picked = await pickIcon({ root, defaultColor, title, factionColor, initialPath });
  if (!picked) return null;

  try {
    await applyIconPathToActorOrToken({ path: picked, actor, tokenDoc, applyTo: target });
    return picked;
  } catch (e) {
    console.error('SpaceHolder | IconPicker: apply failed', e);
    ui.notifications?.error?.(_L('SPACEHOLDER.IconPicker.Errors.ApplyFailed'));
    return null;
  }
}

export async function promptPickAndApplyIconToActorOrToken({
  actor,
  tokenDoc = null,
  root = null,
  defaultColor = '#ffffff',
  title = null,
  factionColor = null,
} = {}) {
  const applyTo = await promptIconApplyTarget();
  if (!applyTo) return null;

  return await pickAndApplyIconToActorOrToken({
    actor,
    tokenDoc,
    applyTo,
    root,
    defaultColor,
    title,
    factionColor,
  });
}
