/**
 * One-time world migration: abilities moved from the ~10 scale to the 100 scale
 * and `dex` was renamed to `agi` (docs/code/reference/DERIVED_STATS.md).
 *
 * What it touches (GM only, once per world; setting `abilityScaleVersion`):
 *  - world Actors: `system.abilities` ×10, `dex` → `agi` (old values are kept in
 *    `flags.spaceholder.migrations.abilityScaleV2.legacyAbilities`);
 *  - Items (world and embedded): ability modifiers ×10, target `abilities.dex` → `abilities.agi`;
 *  - ActiveEffects (actors and items): changes on `system.abilities.*` renamed and scaled
 *    (everything except MULTIPLY);
 *  - unlinked token actor deltas that override abilities.
 *
 * The actor marker is the legacy `dex` key, so a run never scales an actor twice.
 * The pure converters below are covered by `ability-scale-migration.test.mjs`.
 */

export const ABILITY_SCALE_FACTOR = 10;
export const ABILITY_SCALE_VERSION = 2;
export const ABILITY_SCALE_SETTING = 'abilityScaleVersion';
export const ABILITY_SCALE_FLAG = 'abilityScaleV2';

const MODULE_NS = 'spaceholder';
const ABILITY_IDS = Object.freeze(['end', 'str', 'dex', 'cor', 'per', 'int', 'luc']);
const RENAMED = Object.freeze({ dex: 'agi' });

/** ActiveEffect change modes whose value is on the ability scale (everything but MULTIPLY). */
const SCALED_EFFECT_MODES = Object.freeze([2, 3, 4, 5]);

/**
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a legacy `system.abilities` source object. Returns null when the object is not on the
 * legacy schema (no `dex` key): nothing to do or already migrated.
 * @param {object|null|undefined} abilities
 * @returns {{ abilities: Record<string, {value: number}>, legacy: object }|null}
 */
export function convertLegacyAbilities(abilities) {
  if (!abilities || typeof abilities !== 'object' || !Object.prototype.hasOwnProperty.call(abilities, 'dex')) {
    return null;
  }
  const out = {};
  for (const id of ABILITY_IDS) {
    const entry = abilities[id];
    if (!entry || typeof entry !== 'object') continue;
    const target = RENAMED[id] ?? id;
    out[target] = { value: Math.round(num(entry.value) * ABILITY_SCALE_FACTOR) };
  }
  return { abilities: out, legacy: JSON.parse(JSON.stringify(abilities)) };
}

/**
 * Convert an item's `system.modifiers.abilities` list (additive deltas on the old scale).
 * @param {unknown} list
 * @returns {{ list: object[], changed: boolean }}
 */
export function convertModifierList(list) {
  if (!Array.isArray(list) || !list.length) return { list: Array.isArray(list) ? list : [], changed: false };
  let changed = false;
  const out = list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const next = { ...entry };
    for (const key of ['targetId', 'id']) {
      if (next[key] === 'abilities.dex') {
        next[key] = 'abilities.agi';
        changed = true;
      }
    }
    const value = Number(next.value);
    if (Number.isFinite(value) && value !== 0) {
      next.value = value * ABILITY_SCALE_FACTOR;
      changed = true;
    }
    return next;
  });
  return { list: out, changed };
}

/**
 * Convert ActiveEffect changes that target `system.abilities.<id>.value`.
 * @param {unknown} changes
 * @returns {{ changes: object[], changed: boolean }}
 */
export function convertEffectChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return { changes: Array.isArray(changes) ? changes : [], changed: false };
  let changed = false;
  const out = changes.map((change) => {
    const key = String(change?.key ?? '');
    const m = key.match(/^system\.abilities\.([a-z]+)\.value$/);
    if (!m || !ABILITY_IDS.includes(m[1])) return change;
    const next = { ...change };
    const target = RENAMED[m[1]] ?? m[1];
    next.key = `system.abilities.${target}.value`;
    if (SCALED_EFFECT_MODES.includes(Number(change.mode))) {
      const raw = Number(change.value);
      if (Number.isFinite(raw)) next.value = String(raw * ABILITY_SCALE_FACTOR);
    }
    changed = true;
    return next;
  });
  return { changes: out, changed };
}

/* -------------------------------------------- */
/*  Foundry-facing part                         */
/* -------------------------------------------- */

/** Register the hidden world setting that remembers the migration. */
export function registerAbilityScaleMigrationSetting() {
  game.settings.register(MODULE_NS, ABILITY_SCALE_SETTING, {
    scope: 'world',
    config: false,
    type: Number,
    default: 0,
  });
}

/**
 * @param {Actor} actor
 * @returns {Promise<boolean>} true if the actor was changed
 */
async function migrateActor(actor) {
  const source = actor._source?.system?.abilities;
  const converted = convertLegacyAbilities(source);
  if (!converted) return false;
  if (actor.getFlag?.(MODULE_NS, 'migrations')?.[ABILITY_SCALE_FLAG]) return false;

  const update = {
    [`flags.${MODULE_NS}.migrations.${ABILITY_SCALE_FLAG}`]: {
      at: Date.now(),
      legacyAbilities: converted.legacy,
    },
  };
  for (const [id, entry] of Object.entries(converted.abilities)) {
    update[`system.abilities.${id}.value`] = entry.value;
  }
  update['system.abilities.dex'] = new foundry.data.operators.ForcedDeletion();
  await actor.update(update);
  return true;
}

/**
 * @param {Item} item
 * @returns {Promise<boolean>}
 */
async function migrateItem(item) {
  const mods = item._source?.system?.modifiers?.abilities;
  const { list, changed } = convertModifierList(mods);
  if (!changed) return false;
  if (item.getFlag?.(MODULE_NS, 'migrations')?.[ABILITY_SCALE_FLAG]) return false;
  await item.update({
    'system.modifiers.abilities': list,
    [`flags.${MODULE_NS}.migrations.${ABILITY_SCALE_FLAG}`]: true,
  });
  return true;
}

/**
 * @param {Actor|Item} doc document that owns `effects`
 * @returns {Promise<number>} changed effects
 */
async function migrateEffects(doc) {
  let n = 0;
  for (const effect of doc.effects ?? []) {
    if (effect.getFlag?.(MODULE_NS, 'migrations')?.[ABILITY_SCALE_FLAG]) continue;
    const { changes, changed } = convertEffectChanges(effect._source?.changes ?? effect.changes);
    if (!changed) continue;
    await effect.update({
      changes,
      [`flags.${MODULE_NS}.migrations.${ABILITY_SCALE_FLAG}`]: true,
    });
    n += 1;
  }
  return n;
}

/**
 * Run the migration (GM only). Safe to call again: documents already converted are skipped.
 * @param {object} [opts]
 * @param {boolean} [opts.force] ignore the world setting and scan again
 * @returns {Promise<{ actors: number, items: number, effects: number, tokens: number, skipped?: boolean }>}
 */
export async function migrateAbilityScale({ force = false } = {}) {
  const result = { actors: 0, items: 0, effects: 0, tokens: 0 };
  if (!game.user?.isGM) return { ...result, skipped: true };
  if (!force && Number(game.settings.get(MODULE_NS, ABILITY_SCALE_SETTING)) >= ABILITY_SCALE_VERSION) {
    return { ...result, skipped: true };
  }

  const guard = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`SpaceHolder | ability scale migration: ${label} failed`, e);
      return false;
    }
  };

  for (const actor of game.actors ?? []) {
    if (await guard(`actor ${actor.name}`, () => migrateActor(actor))) result.actors += 1;
    result.effects += (await guard(`effects of ${actor.name}`, () => migrateEffects(actor))) || 0;
    for (const item of actor.items ?? []) {
      if (await guard(`item ${item.name}`, () => migrateItem(item))) result.items += 1;
      result.effects += (await guard(`effects of ${item.name}`, () => migrateEffects(item))) || 0;
    }
  }
  for (const item of game.items ?? []) {
    if (await guard(`item ${item.name}`, () => migrateItem(item))) result.items += 1;
    result.effects += (await guard(`effects of ${item.name}`, () => migrateEffects(item))) || 0;
  }

  // Unlinked tokens keep their own overrides in the actor delta.
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;
      const converted = convertLegacyAbilities(token._source?.delta?.system?.abilities);
      if (!converted) continue;
      const update = {};
      for (const [id, entry] of Object.entries(converted.abilities)) {
        update[`delta.system.abilities.${id}.value`] = entry.value;
      }
      update['delta.system.abilities.dex'] = new foundry.data.operators.ForcedDeletion();
      if (await guard(`token ${token.name}`, async () => { await token.update(update); return true; })) result.tokens += 1;
    }
  }

  await game.settings.set(MODULE_NS, ABILITY_SCALE_SETTING, ABILITY_SCALE_VERSION);
  const total = result.actors + result.items + result.effects + result.tokens;
  if (total > 0) {
    console.log('SpaceHolder | ability scale migration finished', result);
    ui.notifications?.info?.(game.i18n.format('SPACEHOLDER.Migration.AbilityScaleDone', {
      actors: result.actors,
      items: result.items,
    }));
  }
  return result;
}
