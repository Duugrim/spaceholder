/** Skill levels are a closed 0–10 scale. */
export const SKILL_LEVEL_MIN = 0;
export const SKILL_LEVEL_MAX = 10;

/** Categories on the Skills tab (practice → theory). */
export const SKILL_CATEGORIES = Object.freeze(['physical', 'mixed', 'knowledge']);

/** Weight of a free-form leaf under a class node (Glock under pistol). */
export const SKILL_CUSTOM_WEIGHT = 5;

/** Missing / untrained node contributes 0. */
export const SKILL_UNTRAINED_LEVEL = 0;

export const SKILL_COLUMNS = Object.freeze([
  { id: 'physical', icon: 'fas fa-hand-fist', labelKey: 'SPACEHOLDER.Skills.Subtabs.Physical' },
  { id: 'mixed', icon: 'fas fa-hammer', labelKey: 'SPACEHOLDER.Skills.Subtabs.Mixed' },
  { id: 'knowledge', icon: 'fas fa-book', labelKey: 'SPACEHOLDER.Skills.Subtabs.Knowledge' },
]);

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function clampSkillLevel(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SKILL_LEVEL_MIN;
  return Math.max(SKILL_LEVEL_MIN, Math.min(SKILL_LEVEL_MAX, Math.round(n)));
}
