/**
 * The quick HUD's item selection: the held items the player picked in the HUD (an actor flag).
 * Kept apart from the HUD itself so the attack chain can read and set it without importing the UI.
 */

/** Actor flag that holds the ids of the HUD-selected items, in selection order. */
export const SELECTION_FLAG = 'quickHudSelectedItemIds';

/**
 * @param {Actor|null|undefined} actor
 * @returns {string[]} HUD-selected item ids (selection order); stale ids are not filtered out
 */
export function getSelectedItemIds(actor) {
  const raw = actor?.getFlag?.('spaceholder', SELECTION_FLAG);
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id ?? '').trim()).filter(Boolean);
}

/**
 * @param {Actor} actor
 * @param {string[]} ids
 */
export async function setSelectedItemIds(actor, ids) {
  await actor.setFlag('spaceholder', SELECTION_FLAG, [...ids]);
}
