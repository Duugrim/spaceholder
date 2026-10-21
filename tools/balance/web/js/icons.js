/** Icons and colour coding: outcome icons, material, damage-type, body-part and weapon-type colours. */

const SVG_NS = 'http://www.w3.org/2000/svg';

const SKULL = '<path fill="currentColor" d="M8 1C4.7 1 2.5 3.3 2.5 6.3c0 1.7.8 3 2 3.9V13c0 .6.4 1 1 1h1v-1.5h1V14h1v-1.5h1V14h1c.6 0 1-.4 1-1v-2.8c1.2-.9 2-2.2 2-3.9C13.5 3.3 11.3 1 8 1z"/>'
  + '<circle cx="5.7" cy="6.9" r="1.55" fill="var(--icon-cut, #111)"/><circle cx="10.3" cy="6.9" r="1.55" fill="var(--icon-cut, #111)"/>'
  + '<path fill="var(--icon-cut, #111)" d="M8 8.7l.9 1.9H7.1z"/>';

const HEART = '<path fill="currentColor" d="M8 14.3S1.4 10.3 1.4 5.9c0-2.1 1.6-3.7 3.6-3.7 1.3 0 2.4.7 3 1.8.6-1.1 1.7-1.8 3-1.8 2 0 3.6 1.6 3.6 3.7 0 4.4-6.6 8.4-6.6 8.4z"/>';

function svgIcon(inner, cls, title) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon ${cls}`);
  svg.setAttribute('role', 'img');
  if (title) svg.setAttribute('aria-label', title);
  svg.innerHTML = inner; // constant markup above, never user input
  return svg;
}

/** Red skull: the worst outcome for the target. */
export const skullIcon = (title = 'Худший исход для цели') => svgIcon(SKULL, 'icon-skull', title);

/** Green heart: the best outcome for the target. */
export const heartIcon = (title = 'Лучший исход для цели') => svgIcon(HEART, 'icon-heart', title);

/* ------------------------------------------------------------------ *
 *  Colours                                                            *
 * ------------------------------------------------------------------ */

const MATERIAL_COLORS = Object.freeze({
  'steel-plate': '#9db4cc',
  'tank-composite': '#7691ad',
  'combat-composite': '#4fb3a6',
  'ceramic-plate': '#dccaa0',
  kevlar: '#e3c24a',
  polymer: '#b48be0',
  foam: '#ec93bb',
  ablative: '#ec8a4c',
  'cloth-light': '#a9d2a0',
  'cloth-heavy': '#74ad78',
  leather: '#b07a4e',
  skin: '#eaaa92',
  muscle: '#d4605f',
  bone: '#ece6d2',
  concrete: '#a5a8ad',
  brick: '#c0604f',
  wood: '#aa8350',
  drywall: '#d6d6c8',
  rock: '#857d70',
  glass: '#7fd0e6',
});

const CATEGORY_COLORS = Object.freeze({
  metal: '#9db4cc',
  composite: '#4fb3a6',
  fabric: '#8fc08a',
  biological: '#d4605f',
  structure: '#a5a8ad',
  ablative: '#ec8a4c',
});

/** Colour of a material slug; custom materials fall back to the colour of their category. */
export function materialColor(slug, category = '') {
  return MATERIAL_COLORS[slug] ?? CATEGORY_COLORS[category] ?? '#8a93a0';
}

const DAMAGE_TYPE_COLORS = Object.freeze({
  ballistic: '#e8a04c',
  concussive: '#c9a27a',
  piercing: '#e0707a',
  cutting: '#d9567f',
  thermal: '#ec7a4a',
  laser: '#f0524f',
  plasma: '#c76be0',
  electric: '#f0d84a',
  sonic: '#8a8ae6',
  radiation: '#8fd84a',
  chemical: '#5fd8a0',
});

export const damageTypeColor = (id) => DAMAGE_TYPE_COLORS[id] ?? '#9aa3ae';

const PART_COLORS = Object.freeze({
  head: '#e5786e',
  neck: '#e59a6e',
  upperTorso: '#e0bb62',
  lowerTorso: '#c9c260',
  shoulder: '#6fb3e6',
  arm: '#6fb3e6',
  hand: '#7cc4d8',
  thigh: '#7fd09a',
  shin: '#7fd09a',
  foot: '#9ad6a8',
});

export const partColor = (id) => PART_COLORS[id] ?? '#9aa3ae';

const TYPE_PALETTE = ['#e5786e', '#e0a45e', '#d6c85e', '#8fcf7a', '#5fcfb3', '#62b4e6', '#7f8fe8', '#b48be0', '#e07fc0', '#a8b4c0'];

/** Accent of a weapon type by its position in the dictionary. */
export const typeColor = (index) => TYPE_PALETTE[((index % TYPE_PALETTE.length) + TYPE_PALETTE.length) % TYPE_PALETTE.length];
