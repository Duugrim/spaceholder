/**
 * Combine aiming-arc luck zone with token-hit centrality into hitLuck.
 * Bands drive group dialog, armor angle, and graze / continue-through.
 */

export const HIT_LUCK_COMBINE_MULTIPLIER = 'multiplier';
export const HIT_LUCK_COMBINE_PENALTY = 'penalty';
export const HIT_LUCK_SETTING_KEY = 'hitLuckCombine';
export const HIT_LUCK_CONTINUE_EPSILON = 0.01;

export const HIT_LUCK_ZONE_ORDER = Object.freeze([
  'purple',
  'green',
  'yellow',
  'orange',
  'red',
]);

export const HIT_LUCK_ZONE_MULTIPLIER = Object.freeze({
  purple: 1.5,
  green: 1.0,
  yellow: 0.75,
  orange: 0.5,
  red: 0.25,
});

export const HIT_LUCK_ZONE_PENALTY = Object.freeze({
  purple: 0.5,
  green: 0,
  yellow: -0.25,
  orange: -0.5,
  red: -0.75,
});

export const HIT_LUCK_BAND = Object.freeze({
  PART_OR_GROUP: 'partOrGroup',
  GROUP: 'group',
  GROUP_45: 'group45',
  GRAZE: 'graze',
  CONTINUE: 'continue',
});

const ARMOR_SCALE_45 = Math.SQRT2;
const ARMOR_SCALE_75 = 1 / Math.cos((75 * Math.PI) / 180);

function _clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function normalizeLuckZone(raw) {
  const z = String(raw ?? '').toLowerCase().trim();
  return HIT_LUCK_ZONE_ORDER.includes(z) ? z : 'green';
}

export function getHitLuckCombineMode() {
  try {
    const v = String(game?.settings?.get?.('spaceholder', HIT_LUCK_SETTING_KEY) ?? '').trim();
    if (v === HIT_LUCK_COMBINE_PENALTY) return HIT_LUCK_COMBINE_PENALTY;
  } catch (_) { /* ignore */ }
  return HIT_LUCK_COMBINE_MULTIPLIER;
}

/**
 * @param {number} centrality 0–1
 * @param {string} zone
 * @param {string} [mode]
 * @returns {number}
 */
export function combineHitLuck(centrality, zone, mode) {
  const c = _clamp01(centrality);
  const z = normalizeLuckZone(zone);
  const m = mode === HIT_LUCK_COMBINE_PENALTY || mode === HIT_LUCK_COMBINE_MULTIPLIER
    ? mode
    : getHitLuckCombineMode();
  if (m === HIT_LUCK_COMBINE_PENALTY) return c + (HIT_LUCK_ZONE_PENALTY[z] ?? 0);
  return c * (HIT_LUCK_ZONE_MULTIPLIER[z] ?? 1);
}

/**
 * @param {number} hitLuck
 * @param {string} [mode]
 * @returns {string} HIT_LUCK_BAND
 */
export function hitLuckBand(hitLuck, mode) {
  const v = Number(hitLuck);
  const m = mode === HIT_LUCK_COMBINE_PENALTY || mode === HIT_LUCK_COMBINE_MULTIPLIER
    ? mode
    : getHitLuckCombineMode();
  if (!Number.isFinite(v) || v <= 0) return HIT_LUCK_BAND.CONTINUE;
  if (m === HIT_LUCK_COMBINE_MULTIPLIER && v < HIT_LUCK_CONTINUE_EPSILON) {
    return HIT_LUCK_BAND.CONTINUE;
  }
  if (v > 0.75) return HIT_LUCK_BAND.PART_OR_GROUP;
  if (v > 0.50) return HIT_LUCK_BAND.GROUP;
  if (v > 0.25) return HIT_LUCK_BAND.GROUP_45;
  return HIT_LUCK_BAND.GRAZE;
}

export function armorScaleForBand(band) {
  if (band === HIT_LUCK_BAND.GROUP_45) return ARMOR_SCALE_45;
  if (band === HIT_LUCK_BAND.GRAZE) return ARMOR_SCALE_75;
  return 1;
}

export function canPickSpecificPart(band) {
  return band === HIT_LUCK_BAND.PART_OR_GROUP;
}

export function isGrazeBand(band) {
  return band === HIT_LUCK_BAND.GRAZE;
}

export function isContinueBand(band) {
  return band === HIT_LUCK_BAND.CONTINUE;
}

/**
 * Shift luck zone one step toward green (never to purple).
 * @param {string} zone
 * @returns {string}
 */
export function upgradeLuckZoneTowardGreen(zone) {
  const z = normalizeLuckZone(zone);
  const i = HIT_LUCK_ZONE_ORDER.indexOf(z);
  if (i <= 1) return 'green';
  return HIT_LUCK_ZONE_ORDER[i - 1];
}

/**
 * Clock hours relative to target facing (12 = facing = front).
 * Hours 9–3 via 12 → front; 3–9 via 6 → back.
 * @param {number} clock
 * @returns {'front'|'back'}
 */
export function clockToHitFace(clock) {
  const n = Number(clock);
  if (!Number.isFinite(n)) return 'front';
  let hours = n % 12;
  if (hours < 0) hours += 12;
  if (hours > 3 && hours < 9) return 'back';
  return 'front';
}

/**
 * @param {object} args
 * @param {number} args.centrality
 * @param {string} args.zone
 * @param {string} [args.mode]
 * @returns {{ hitLuck:number, band:string, armorScale:number, zone:string, centrality:number, mode:string }}
 */
export function resolveHitLuck({ centrality, zone, mode } = {}) {
  const m = mode === HIT_LUCK_COMBINE_PENALTY || mode === HIT_LUCK_COMBINE_MULTIPLIER
    ? mode
    : getHitLuckCombineMode();
  const z = normalizeLuckZone(zone);
  const c = _clamp01(centrality);
  const luck = combineHitLuck(c, z, m);
  const band = hitLuckBand(luck, m);
  return {
    hitLuck: luck,
    band,
    armorScale: armorScaleForBand(band),
    zone: z,
    centrality: c,
    mode: m,
  };
}

const BAND_I18N = {
  [HIT_LUCK_BAND.PART_OR_GROUP]: 'SPACEHOLDER.AnatomyGroups.BandPartOrGroup',
  [HIT_LUCK_BAND.GROUP]: 'SPACEHOLDER.AnatomyGroups.BandGroup',
  [HIT_LUCK_BAND.GROUP_45]: 'SPACEHOLDER.AnatomyGroups.BandGroup45',
  [HIT_LUCK_BAND.GRAZE]: 'SPACEHOLDER.AnatomyGroups.BandGraze',
  [HIT_LUCK_BAND.CONTINUE]: 'SPACEHOLDER.AnatomyGroups.BandContinue',
};

export function localizeHitLuckBand(band) {
  const key = BAND_I18N[band];
  const loc = key ? game?.i18n?.localize?.(key) : '';
  return (loc && loc !== key) ? loc : String(band ?? '');
}

/**
 * Shooter dialog: pick a group (and optionally a part).
 * @returns {Promise<{groupId:string|null, partId:string|null}>}
 */
export async function promptHitGroupDialog({ actor, resolved, groups, allowPart = false } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return { groupId: null, partId: null };
  const L = (k, f) => {
    const v = game?.i18n?.localize?.(k);
    return v && v !== k ? v : f;
  };
  const luckFmt = game?.i18n?.format?.('SPACEHOLDER.AnatomyGroups.HitLuck', {
    value: Number(resolved?.hitLuck ?? 0).toFixed(2),
    band: localizeHitLuckBand(resolved?.band),
  }) ?? String(resolved?.hitLuck ?? '');

  const groupOpts = list.map((g) =>
    `<option value="${String(g.id).replace(/"/g, '&quot;')}">${String(g.name || g.id)}</option>`
  ).join('');

  const bodyParts = actor?.system?.health?.bodyParts ?? {};
  const partOpts = allowPart
    ? Object.entries(bodyParts).map(([slot, p]) =>
      `<option value="${String(slot).replace(/"/g, '&quot;')}">${String(p.displayName || p.name || p.id || slot)}</option>`
    ).join('')
    : '';

  const partBlock = allowPart
    ? `<div class="form-group"><label>${L('SPACEHOLDER.AnatomyGroups.PickPart', 'Part')}</label>
        <select id="hg-part"><option value="">${L('SPACEHOLDER.AnatomyGroups.AnyPart', '—')}</option>${partOpts}</select></div>`
    : '';

  const content = `<div class="spaceholder-hit-group-dialog">
    <p>${luckFmt}</p>
    <div class="form-group"><label>${L('SPACEHOLDER.AnatomyGroups.PickGroup', 'Group')}</label>
      <select id="hg-group">${groupOpts}</select></div>
    ${partBlock}
  </div>`;

  let groupId = list[0]?.id ?? null;
  let partId = null;
  await foundry.applications.api.DialogV2.wait({
    window: { title: L('SPACEHOLDER.AnatomyGroups.HitDialogTitle', 'Hit'), icon: 'fa-solid fa-crosshairs' },
    position: { width: 360 },
    classes: ['spaceholder'],
    content,
    buttons: [
      {
        action: 'ok',
        label: L('SPACEHOLDER.AnatomyGroups.Confirm', 'Hit'),
        icon: 'fa-solid fa-check',
        default: true,
        callback: (ev) => {
          const root = ev?.currentTarget ?? document;
          groupId = String(root.querySelector('#hg-group')?.value ?? '').trim() || groupId;
          partId = allowPart ? (String(root.querySelector('#hg-part')?.value ?? '').trim() || null) : null;
        },
      },
    ],
  });
  return { groupId, partId };
}
