/**
 * Weapon data shape (v3, «Оружие → Действие»):
 *   weapon.version === 3
 *   weapon.ergonomics — aiming arc modifiers + readying (see weapon-model.mjs)
 *   weapon.lines[]    — attack lines (params, ammo blocks, fire modes)
 *   weapon.state      — runtime: active line/mode, readiness
 *   weapon.ammo       — ammo item config (matters when itemTags.isAmmo)
 *
 * Model lives in module/helpers/weapon/weapon-model.mjs; this document class
 * only wires normalization into Foundry's migrateData.
 */
import { normalizeNestedStorage } from '../helpers/item-nested-storage.mjs';
import { migratePersistedContainerContents, releaseDirectContainerChildrenToRoot } from '../helpers/item-container.mjs';
import { normalizeWeaponV3 } from '../helpers/weapon/weapon-model.mjs';

function _shPositiveHardness(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1e-9 ? n : 1;
}

/**
 * Normalize a projectile.applications value into the canonical phased shape
 *   `[{ mode: 'sequential'|'parallel', items: [{type,damage,armorPen?,armorDamageFactor?,hardness?}, ...] }, ...]`.
 *
 * Accepts:
 *   - empty/missing → `[]` (legacy single-damage projectiles fall back to
 *     `damage`/`damageType` at runtime via `damage-resolver.normalizeApplications`).
 *   - flat array of items → wrapped in a single sequential phase.
 *   - already phased array → re-emitted with sanitised entries.
 *
 * Items with non-positive damage or unknown types are dropped silently.
 *
 * @param {unknown} raw
 * @returns {Array<{mode: string, items: Array<{type:string,damage:number,armorPen:number,armorDamageFactor:number,hardness:number}>}>}
 */
function _shNormProjectileApplications(raw) {
  if (raw == null || raw === '') return [];
  const sanitiseItem = (item) => {
    if (!item || typeof item !== 'object') return null;
    const type = String(item.type ?? '').trim();
    if (!type) return null;
    const damage = Number(item.damage ?? 0);
    if (!Number.isFinite(damage) || damage <= 0) return null;
    const armorPen = Number(item.armorPen ?? 0);
    const armorDamageFactor = Number(item.armorDamageFactor ?? 1);
    const out = {
      type,
      damage,
      armorPen: Number.isFinite(armorPen) && armorPen > 0 ? armorPen : 0,
      armorDamageFactor: Number.isFinite(armorDamageFactor) && armorDamageFactor > 0 ? armorDamageFactor : 1,
      hardness: _shPositiveHardness(item.hardness ?? 1),
    };
    const reduction = Number(item.armorDamageReduction);
    if (Number.isFinite(reduction)) out.armorDamageReduction = Math.max(0, reduction);
    const energy = Number(item.energy);
    if (Number.isFinite(energy) && energy >= 0) out.energy = energy;
    return out;
  };
  const sanitisePhase = (phase) => {
    if (!phase || typeof phase !== 'object' || !Array.isArray(phase.items)) return null;
    const mode = phase.mode === 'parallel' ? 'parallel' : 'sequential';
    const items = phase.items.map(sanitiseItem).filter(Boolean);
    if (!items.length) return null;
    return { mode, items };
  };
  if (!Array.isArray(raw)) return [];
  const looksPhased = raw.length && raw.every((entry) => entry && typeof entry === 'object' && Array.isArray(entry.items));
  if (looksPhased) return raw.map(sanitisePhase).filter(Boolean);
  const items = raw.map(sanitiseItem).filter(Boolean);
  return items.length ? [{ mode: 'sequential', items }] : [];
}

/**
 * Compose a phased applications package from a projectile config. If the
 * projectile defines an `applications` array (post-migration), use it
 * verbatim. Otherwise, build a one-item sequential package from the legacy
 * `damage`/`damageType`/`armorPen`/`armorDamageFactor`/`hardness` fields.
 *
 * Returns `[]` when the projectile carries no usable damage spec.
 *
 * @param {object} projectile
 * @returns {Array<{mode:string, items:Array<object>}>}
 */
export function buildProjectileApplications(projectile) {
  if (!projectile || typeof projectile !== 'object') return [];
  const explicit = _shNormProjectileApplications(projectile.applications);
  if (explicit.length) return explicit;
  const type = String(projectile.damageType ?? '').trim();
  const damage = Number(projectile.damage ?? 0);
  if (!type || !Number.isFinite(damage) || damage <= 0) return [];
  const armorPen = Number(projectile.armorPen ?? 0);
  const armorDamageFactor = Number(projectile.armorDamageFactor ?? 1);
  return [{
    mode: 'sequential',
    items: [{
      type,
      damage,
      armorPen: Number.isFinite(armorPen) && armorPen > 0 ? armorPen : 0,
      armorDamageFactor: Number.isFinite(armorDamageFactor) && armorDamageFactor > 0 ? armorDamageFactor : 1,
      hardness: _shPositiveHardness(projectile.hardness ?? 1),
    }],
  }];
}

/**
 * Compose the canonical phased applications package for a projectile.
 * Order of precedence:
 *   1. If `projectile.builderId` is set and the corresponding entry exists
 *      in `CONFIG.SPACEHOLDER.applicationBuilders`, invoke it with `ctx`
 *      (`{ projectile, ...ctx }`) and use whatever it returns. The builder
 *      may return either a phased array, a flat array of items, or a
 *      legacy `{type, damage}` pair — anything `_shNormProjectileApplications`
 *      can normalize.
 *   2. Otherwise fall back to {@link buildProjectileApplications}, which
 *      uses `projectile.applications` if present and the legacy
 *      single-shot fields otherwise.
 *
 * Builder failures are logged and silently fall through to the static path.
 *
 * @param {object} projectile
 * @param {object} [ctx] - extra context forwarded to the builder
 * @returns {Array<{mode:string, items:Array<object>}>}
 */
export function composeProjectileApplications(projectile, ctx = {}) {
  if (!projectile || typeof projectile !== 'object') return [];
  const builderId = String(projectile.builderId ?? '').trim();
  if (builderId) {
    const registry = (typeof CONFIG !== 'undefined' && CONFIG?.SPACEHOLDER?.applicationBuilders) || {};
    const builder = registry[builderId];
    if (typeof builder === 'function') {
      try {
        const built = builder({ ...ctx, projectile });
        const phases = _shNormProjectileApplications(built);
        if (phases.length) return phases;
      } catch (e) {
        console.error(`SpaceHolder | Application builder "${builderId}" failed:`, e);
      }
    } else {
      console.warn(`SpaceHolder | Unknown application builder id: ${builderId}`);
    }
  }
  return buildProjectileApplications(projectile);
}

/**
 * Normalize `system.weapon` for items (sheet display + persistence).
 * v3 model; pre-v3 (v1/v2) data is discarded by design — the refactor does
 * not migrate legacy weapon shapes.
 * @param {object} weapon
 * @param {object} itemTags
 * @returns {object}
 */
export function migrateItemWeaponData(weapon, itemTags) {
  return normalizeWeaponV3(weapon, itemTags);
}

/**
 * Extend the basic Item with some very simple modifications.
 * @extends {Item}
 */
export class SpaceHolderItem extends Item {
  /**
   * v14 compatibility: short-circuit no-op updates that carry no actual changes
   * (only `_id` or completely empty). Foundry's `#onSubmitDocumentForm` can invoke
   * `_processSubmitData` with `{}` after a failed validate, and the resulting
   * `cleanData({_id})` then throws "must be constructed with a DataModel or Object".
   * The `type`/`name` injection is handled in `updateSource` (the chokepoint for
   * all update code paths).
   * @inheritDoc
   */
  async update(data, operation) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const meaningfulKeys = Object.keys(data).filter((k) => k !== '_id');
      if (meaningfulKeys.length === 0) return this;
    }
    return super.update(data, operation);
  }

  /**
   * v14 compatibility: Foundry's update pipeline (preUpdateDocumentArray,
   * #handleUpdateDocuments, and validate via _prepareSubmitData) expands partial
   * change objects via `cleanData` with `addTypes:true`, which adds schema keys
   * (`type`, `name`) but leaves them as `undefined` because static `cleanData`
   * doesn't know `_source`. Foundry's `_updateDiff` then either sees
   * `_source.type !== changes.type (undefined)` and throws "ForcedReplacement", or
   * validates `name: undefined` and throws a schema error. Inject the persisted
   * values for any required-without-default field that ended up undefined.
   * @inheritDoc
   */
  updateSource(changes, options) {
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      const src = this._source ?? {};
      if ((!('type' in changes) || changes.type === undefined || changes.type === null) && src.type !== undefined) {
        changes.type = src.type;
      }
      if ((!('name' in changes) || changes.name === undefined || changes.name === null) && src.name !== undefined) {
        changes.name = src.name;
      }
    }
    return super.updateSource(changes, options);
  }

  /**
   * When a container host Item is removed, direct children must not keep a stale
   * `containerHostId` or they disappear from root inventory lists.
   * @inheritDoc
   */
  async delete(options = {}) {
    if (
      this.type === 'item' &&
      this.system?.itemTags?.isContainer &&
      this.isEmbedded === true &&
      this.actor
    ) {
      try {
        await releaseDirectContainerChildrenToRoot(this.actor, this.id);
      } catch (error) {
        console.error('SpaceHolder | release container children before Item delete', error);
      }
    }
    return super.delete(options);
  }

  /**
   * Merge legacy `wearable` into `item` and backfill unified `item.system` fields.
   * @param {object} source
   * @param {object} [migrationData]
   * @returns {object}
   */
  static migrateData(source, migrationData) {
    // v14: Foundry calls migrateData on partial update payloads via DataModelSchemaField.clean.
    // We must NOT inject schema defaults here, otherwise the diff vs. _source includes
    // spurious resets (e.g. itemTags={isArmor:false,...}) that wipe user data.
    // Only do legacy shape migration on full source documents (migrationData.partial is falsy).
    if (migrationData?.partial) return super.migrateData(source, migrationData);

    if (source.type === 'wearable') source.type = 'item';

    if (source.type === 'item' && source.system && typeof source.system === 'object') {
      const s = source.system;
      if (s.equipped === undefined) s.equipped = false;
      if (s.held === undefined) s.held = false;
      if (s.equipped) s.held = false;
      if (s.anatomyId === undefined) s.anatomyId = null;
      if (!Array.isArray(s.coveredParts)) s.coveredParts = [];
      s.storage = normalizeNestedStorage(s.storage);
      if (!s.defaultActions || typeof s.defaultActions !== 'object') {
        s.defaultActions = {
          equip: { showInCombat: false, showInQuickbar: true },
          unequip: { showInCombat: false, showInQuickbar: true },
          hold: { showInCombat: false, showInQuickbar: true },
          stow: { showInCombat: false, showInQuickbar: true },
          drop: { showInCombat: false, showInQuickbar: false },
          wear: { showInCombat: false, showInQuickbar: false },
          show: { showInCombat: false, showInQuickbar: false },
        };
      } else {
        s.defaultActions.equip = s.defaultActions.equip || { showInCombat: false, showInQuickbar: true };
        s.defaultActions.unequip = s.defaultActions.unequip || { showInCombat: false, showInQuickbar: true };
        s.defaultActions.hold = s.defaultActions.hold || { showInCombat: false, showInQuickbar: true };
        s.defaultActions.stow = s.defaultActions.stow || { showInCombat: false, showInQuickbar: true };
        s.defaultActions.drop = s.defaultActions.drop || { showInCombat: false, showInQuickbar: false };
        s.defaultActions.wear = s.defaultActions.wear || { showInCombat: false, showInQuickbar: false };
        s.defaultActions.show = s.defaultActions.show || { showInCombat: false, showInQuickbar: false };
      }
      if (!s.modifiers || typeof s.modifiers !== 'object') {
        s.modifiers = { abilities: [], derived: [], params: [] };
      } else {
        s.modifiers.abilities = Array.isArray(s.modifiers.abilities) ? s.modifiers.abilities : [];
        s.modifiers.derived = Array.isArray(s.modifiers.derived) ? s.modifiers.derived : [];
        s.modifiers.params = Array.isArray(s.modifiers.params) ? s.modifiers.params : [];
      }
      if (s.formula === undefined) {
        s.formula = 'd20 + @str.mod + ceil(@lvl / 2)';
      }
      if (s.containerHostId === undefined || s.containerHostId === null) {
        s.containerHostId = '';
      } else {
        s.containerHostId = String(s.containerHostId).trim();
      }
      if (!s.container || typeof s.container !== 'object') {
        s.container = { contents: [] };
      } else {
        const c = s.container;
        c.contents = migratePersistedContainerContents(c.contents);
      }

      if (!s.itemTags || typeof s.itemTags !== 'object') {
        s.itemTags = {
          isArmor: false,
          isActions: false,
          isModifiers: false,
          isWeapon: false,
          isAmmo: false,
          isContainer: false,
        };
      } else {
        const t = s.itemTags;
        t.isArmor = !!t.isArmor;
        t.isActions = !!t.isActions;
        t.isModifiers = !!t.isModifiers;
        t.isAmmo = !!t.isAmmo;
        t.isContainer = !!t.isContainer;
        // Legacy melee/ranged/thrown kinds collapse into the unified weapon tag.
        t.isWeapon = !!(t.isWeapon || t.isMelee || t.isRanged || t.isThrown);
        delete t.isMelee;
        delete t.isRanged;
        delete t.isThrown;
      }

      s.weapon = migrateItemWeaponData(s.weapon, s.itemTags);
    }

    return super.migrateData(source, migrationData);
  }

  /**
   * Augment the basic Item data model with additional dynamic data.
   */
  prepareData() {
    // As with the actor class, items are documents that can have their data
    // preparation methods overridden (such as prepareBaseData()).
    super.prepareData();
  }

  /**
   * Prepare a data object which defines the data schema used by dice roll commands against this Item
   * @override
   */
  getRollData() {
    // Starts off by populating the roll data with a shallow copy of `this.system`
    const rollData = { ...this.system };

    // Quit early if there's no parent actor
    if (!this.actor) return rollData;

    // If present, add the actor's roll data
    rollData.actor = this.actor.getRollData();

    return rollData;
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  async roll() {
    const item = this;

    // Initialize chat data.
    const speaker = ChatMessage.getSpeaker({ actor: this.actor });
    const rollMode = game.settings.get('core', 'rollMode');
    const label = `[${item.type}] ${item.name}`;

    // If there's no roll data, send a chat message.
    if (!this.system.formula) {
      ChatMessage.create({
        speaker: speaker,
        rollMode: rollMode,
        flavor: label,
        content: item.system.description ?? '',
      });
    }
    // Otherwise, create a roll and send a chat message from it.
    else {
      // Retrieve roll data.
      const rollData = this.getRollData();

      // Invoke the roll and submit it to chat.
      const roll = new Roll(rollData.formula, rollData);
      // If you need to store the value first, uncomment the next line.
      // const result = await roll.evaluate();
      roll.toMessage({
        speaker: speaker,
        rollMode: rollMode,
        flavor: label,
      });
      return roll;
    }
  }
}
