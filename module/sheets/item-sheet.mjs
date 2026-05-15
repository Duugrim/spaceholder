import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { enrichHTMLWithFactionIcons } from '../helpers/faction-display.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';
import { pickIcon } from '../helpers/icon-picker/icon-picker.mjs';
import { migrateItemWeaponData } from '../documents/item.mjs';
import { materialsManager } from '../helpers/damage/materials-manager.mjs';
import {
  addItemToNestedStorage,
  extractNestedItemToActor,
  flattenNestedContents,
  normalizeNestedStorage,
  NESTED_STORAGE_FEED_SOURCES,
} from '../helpers/item-nested-storage.mjs';
import {
  ENTRY_ACTOR_ITEM,
  ENTRY_WORLD_UUID,
  addWorldUuidToContainer,
  moveActorItemIntoContainer,
  normalizeItemContainerFields,
  pruneBrokenWorldUuidLinks,
  refreshContainerState,
  removeActorItemFromContainer,
  removeWorldUuidFromContainer,
  rerenderOpenContainerRelatedSheets,
  setContainerContentsOrder,
  setWorldContainerContentsOrder,
  wouldCreateItemContainerCycle,
} from '../helpers/item-container.mjs';

/**
 * Build a short human-readable summary of armor layers for a coverage entry.
 * Example: "3mm Steel Plate, 5mm Kevlar Weave".
 *
 * @param {Array<Object>|undefined} layers
 * @returns {string}
 */
function formatCoverageLayersSummary(layers) {
  if (!Array.isArray(layers) || !layers.length) return '';
  return layers.map((layer) => {
    const thickness = Number(layer?.thickness);
    const slug = String(layer?.material ?? '').trim();
    if (!slug || !Number.isFinite(thickness) || thickness <= 0) return '';
    const md = materialsManager?.getMaterial?.(slug);
    const localized = md?.nameLocalized ? game.i18n?.localize?.(md.nameLocalized) : '';
    const name = (localized && localized !== md?.nameLocalized) ? localized : (md?.name || slug);
    const t = Math.round(thickness * 100) / 100;
    return `${t}mm ${name}`;
  }).filter(Boolean).join(', ');
}
/**
 * Вкладки оружия на листе предмета правят только `system.weapon` (авторинг данных).
 * Подсистемы стрельбы / боя / `action-service` на этом этапе эти поля не используют.
 */

const ITEM_SHEET_TAB_META = Object.freeze({
  description: { icon: 'fas fa-file-lines', labelKey: 'SPACEHOLDER.Tabs.Description' },
  attributes: { icon: 'fas fa-sliders', labelKey: 'SPACEHOLDER.Tabs.Attributes' },
  actions: { icon: 'fas fa-bolt', labelKey: 'SPACEHOLDER.ActionsSystem.UI.ActionsTab' },
  effects: { icon: 'fas fa-wand-magic-sparkles', labelKey: 'SPACEHOLDER.Tabs.Effects' },
  tags: { icon: 'fas fa-tags', labelKey: 'SPACEHOLDER.Tabs.Tags' },
  modifiers: { icon: 'fas fa-dumbbell', labelKey: 'SPACEHOLDER.Tabs.Modifiers' },
  melee: { icon: 'fas fa-hand-fist', labelKey: 'SPACEHOLDER.ItemWeapon.Inner.Melee' },
  ranged: { icon: 'fas fa-crosshairs', labelKey: 'SPACEHOLDER.ItemWeapon.Inner.Ranged' },
  thrown: { icon: 'fas fa-baseball', labelKey: 'SPACEHOLDER.ItemWeapon.Inner.Thrown' },
  ammo: { icon: 'fas fa-bullseye', labelKey: 'SPACEHOLDER.Tabs.Ammo' },
  container: { icon: 'fas fa-box-open', labelKey: 'SPACEHOLDER.ItemContainer.Tab' },
});

/**
 * @param {string[]} tabIds
 * @param {Record<string, { icon: string, labelKey: string }>} [overrides]
 */
function buildItemSheetPrimaryTabs(tabIds, overrides = {}) {
  const out = [];
  for (const id of tabIds) {
    const row = overrides[id] || ITEM_SHEET_TAB_META[id];
    if (row) out.push({ id, icon: row.icon, labelKey: row.labelKey });
  }
  return Object.freeze(out);
}

const ITEM_TYPE_LABEL_KEYS = Object.freeze({
  item: 'SPACEHOLDER.ItemTypes.Item',
  feature: 'SPACEHOLDER.ItemTypes.Feature',
  spell: 'SPACEHOLDER.ItemTypes.Spell',
  material: 'SPACEHOLDER.ItemTypes.Material',
});

const ITEM_TYPE_ICON_CLASS = Object.freeze({
  item: 'fa-solid fa-box',
  feature: 'fa-solid fa-star',
  spell: 'fa-solid fa-wand-magic-sparkles',
  material: 'fa-solid fa-cubes-stacked',
});

const MATERIAL_CATEGORY_OPTIONS = Object.freeze([
  { id: 'metal', labelKey: 'SPACEHOLDER.Materials.Categories.Metal' },
  { id: 'fabric', labelKey: 'SPACEHOLDER.Materials.Categories.Fabric' },
  { id: 'ceramic', labelKey: 'SPACEHOLDER.Materials.Categories.Ceramic' },
  { id: 'composite', labelKey: 'SPACEHOLDER.Materials.Categories.Composite' },
  { id: 'ablative', labelKey: 'SPACEHOLDER.Materials.Categories.Ablative' },
  { id: 'exotic', labelKey: 'SPACEHOLDER.Materials.Categories.Exotic' },
]);

const ITEM_ACTION_MODE_LABEL_KEYS = Object.freeze({
  chat: 'SPACEHOLDER.ActionsSystem.UI.ModeChat',
  itemRoll: 'SPACEHOLDER.ActionsSystem.UI.ModeItemRoll',
  macro: 'SPACEHOLDER.ActionsSystem.UI.ModeMacro',
  aimShot: 'SPACEHOLDER.ActionsSystem.UI.ModeAimShot',
});

/**
 * Field schemas for weapon / ammo group dialogs. The same descriptors drive:
 *  - panel rows in the channel/ammo tab,
 *  - inputs in the universal group dialog,
 *  - parsing dialog form back into the weapon data object.
 *
 * `kind` ∈ { 'number', 'int', 'text', 'bool', 'tags' }.
 */
const WEAPON_FIELD_SCHEMAS = Object.freeze({
  melee: Object.freeze({
    features: Object.freeze([
      { name: 'ergonomics', labelKey: 'SPACEHOLDER.ItemWeapon.Ergonomics', kind: 'number' },
      { name: 'reach', labelKey: 'SPACEHOLDER.ItemWeapon.Reach', kind: 'number' },
      { name: 'twoHanded', labelKey: 'SPACEHOLDER.ItemWeapon.TwoHanded', kind: 'bool' },
      { name: 'parryBonus', labelKey: 'SPACEHOLDER.ItemWeapon.ParryBonus', kind: 'number' },
      { name: 'swingSpeedTier', labelKey: 'SPACEHOLDER.ItemWeapon.SwingSpeedTier', kind: 'text' },
    ]),
    projectile: Object.freeze([
      { name: 'damage', labelKey: 'SPACEHOLDER.ItemWeapon.Damage', kind: 'number' },
      { name: 'damageType', labelKey: 'SPACEHOLDER.ItemWeapon.DamageType', kind: 'text' },
      { name: 'armorPen', labelKey: 'SPACEHOLDER.ItemWeapon.ArmorPen', kind: 'number' },
      { name: 'armorDamageFactor', labelKey: 'SPACEHOLDER.ItemWeapon.ArmorDamageFactor', kind: 'number' },
      { name: 'hardness', labelKey: 'SPACEHOLDER.ItemWeapon.Hardness', kind: 'number' },
      { name: 'projectilesPerUse', labelKey: 'SPACEHOLDER.ItemWeapon.ProjectilesPerUse', kind: 'int', min: 1 },
      { name: 'payloadId', labelKey: 'SPACEHOLDER.ItemWeapon.PayloadId', kind: 'text', placeholderKey: 'SPACEHOLDER.ItemWeapon.PayloadIdHint' },
      { name: 'combatPartTag', labelKey: 'SPACEHOLDER.ItemWeapon.CombatPartTag', kind: 'text' },
    ]),
    usage: Object.freeze([
      { name: 'apCost', labelKey: 'SPACEHOLDER.ItemWeapon.ApCost', kind: 'int', min: 0 },
      { name: 'requiresHolding', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresHolding', kind: 'bool' },
      { name: 'requiresReadyState', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresReadyState', kind: 'bool' },
    ]),
  }),
  ranged: Object.freeze({
    features: Object.freeze([
      { name: 'ergonomics', labelKey: 'SPACEHOLDER.ItemWeapon.Ergonomics', kind: 'number' },
      { name: 'accuracy', labelKey: 'SPACEHOLDER.ItemWeapon.Accuracy', kind: 'number' },
      { name: 'recoil', labelKey: 'SPACEHOLDER.ItemWeapon.Recoil', kind: 'number' },
      { name: 'chamberEnabled', labelKey: 'SPACEHOLDER.ItemWeapon.ChamberEnabled', kind: 'bool' },
      { name: 'effectiveRange', labelKey: 'SPACEHOLDER.ItemWeapon.EffectiveRange', kind: 'number' },
      { name: 'maxRange', labelKey: 'SPACEHOLDER.ItemWeapon.MaxRange', kind: 'number' },
      { name: 'twoHanded', labelKey: 'SPACEHOLDER.ItemWeapon.TwoHanded', kind: 'bool' },
    ]),
    projectile: Object.freeze([
      { name: 'damage', labelKey: 'SPACEHOLDER.ItemWeapon.Damage', kind: 'number' },
      { name: 'damageType', labelKey: 'SPACEHOLDER.ItemWeapon.DamageType', kind: 'text' },
      { name: 'armorPen', labelKey: 'SPACEHOLDER.ItemWeapon.ArmorPen', kind: 'number' },
      { name: 'armorDamageFactor', labelKey: 'SPACEHOLDER.ItemWeapon.ArmorDamageFactor', kind: 'number' },
      { name: 'hardness', labelKey: 'SPACEHOLDER.ItemWeapon.Hardness', kind: 'number' },
      { name: 'projectilesPerUse', labelKey: 'SPACEHOLDER.ItemWeapon.ProjectilesPerUse', kind: 'int', min: 1 },
      { name: 'payloadId', labelKey: 'SPACEHOLDER.ItemWeapon.PayloadId', kind: 'text', placeholderKey: 'SPACEHOLDER.ItemWeapon.PayloadIdHint' },
    ]),
    usage: Object.freeze([
      { name: 'apCost', labelKey: 'SPACEHOLDER.ItemWeapon.ApCost', kind: 'int', min: 0 },
      { name: 'reloadApCost', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoReloadApCost', kind: 'int', min: 0 },
      { name: 'reloadRule', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoReloadRule', kind: 'text' },
      { name: 'feedSource', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoFeedSource', kind: 'text' },
      { name: 'ammoUseMode', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoUseMode', kind: 'text', placeholderKey: 'SPACEHOLDER.ItemWeapon.AmmoUseModeHint' },
      { name: 'takeFromActorInventory', labelKey: 'SPACEHOLDER.ItemWeapon.TakeFromActorInventory', kind: 'bool' },
      { name: 'attachedContainerId', labelKey: 'SPACEHOLDER.ItemWeapon.AttachedContainerId', kind: 'text' },
      { name: 'feedFilterTags', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoFeedFilterTags', kind: 'tags', placeholderKey: 'SPACEHOLDER.ItemWeapon.TagsCommaSeparated' },
      { name: 'consumePerUse', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoConsumePerUse', kind: 'number' },
      { name: 'chamberCurrentId', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoChamberCurrentId', kind: 'text' },
      { name: 'canKeepChamberOnReload', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoKeepChamberOnReload', kind: 'bool' },
      { name: 'requiresHolding', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresHolding', kind: 'bool' },
      { name: 'requiresReadyState', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresReadyState', kind: 'bool' },
      { name: 'requiresAimState', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresAimState', kind: 'bool' },
    ]),
  }),
  thrown: Object.freeze({
    features: Object.freeze([
      { name: 'ergonomics', labelKey: 'SPACEHOLDER.ItemWeapon.Ergonomics', kind: 'number' },
      { name: 'accuracy', labelKey: 'SPACEHOLDER.ItemWeapon.Accuracy', kind: 'number' },
      { name: 'throwRange', labelKey: 'SPACEHOLDER.ItemWeapon.ThrowRange', kind: 'number' },
      { name: 'aerodynamics', labelKey: 'SPACEHOLDER.ItemWeapon.Aerodynamics', kind: 'number' },
      { name: 'twoHanded', labelKey: 'SPACEHOLDER.ItemWeapon.TwoHanded', kind: 'bool' },
    ]),
    projectile: Object.freeze([
      { name: 'damage', labelKey: 'SPACEHOLDER.ItemWeapon.Damage', kind: 'number' },
      { name: 'damageType', labelKey: 'SPACEHOLDER.ItemWeapon.DamageType', kind: 'text' },
      { name: 'armorPen', labelKey: 'SPACEHOLDER.ItemWeapon.ArmorPen', kind: 'number' },
      { name: 'armorDamageFactor', labelKey: 'SPACEHOLDER.ItemWeapon.ArmorDamageFactor', kind: 'number' },
      { name: 'hardness', labelKey: 'SPACEHOLDER.ItemWeapon.Hardness', kind: 'number' },
      { name: 'projectilesPerUse', labelKey: 'SPACEHOLDER.ItemWeapon.ProjectilesPerUse', kind: 'int', min: 1 },
      { name: 'payloadId', labelKey: 'SPACEHOLDER.ItemWeapon.PayloadId', kind: 'text', placeholderKey: 'SPACEHOLDER.ItemWeapon.PayloadIdHint' },
      { name: 'aoeRadius', labelKey: 'SPACEHOLDER.ItemWeapon.AoeRadius', kind: 'number' },
    ]),
    usage: Object.freeze([
      { name: 'apCost', labelKey: 'SPACEHOLDER.ItemWeapon.ApCost', kind: 'int', min: 0 },
      { name: 'prepareApCost', labelKey: 'SPACEHOLDER.ItemWeapon.PrepareApCost', kind: 'int', min: 0 },
      { name: 'consumeOnUse', labelKey: 'SPACEHOLDER.ItemWeapon.ConsumeOnUse', kind: 'bool' },
      { name: 'retrievable', labelKey: 'SPACEHOLDER.ItemWeapon.Retrievable', kind: 'bool' },
      { name: 'requiresHolding', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresHolding', kind: 'bool' },
      { name: 'requiresReadyState', labelKey: 'SPACEHOLDER.ItemWeapon.RequiresReadyState', kind: 'bool' },
    ]),
  }),
});

const AMMO_FIELD_SCHEMAS = Object.freeze({
  projectile: WEAPON_FIELD_SCHEMAS.ranged.projectile,
  resource: Object.freeze([
    { name: 'resourceType', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoResourceType', kind: 'text' },
    { name: 'caliberTag', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoCaliberTag', kind: 'text' },
    { name: 'compatibilityTags', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoCompatibilityTags', kind: 'tags', placeholderKey: 'SPACEHOLDER.ItemWeapon.TagsCommaSeparated' },
    { name: 'stackMax', labelKey: 'SPACEHOLDER.ItemWeapon.AmmoStackMax', kind: 'int', min: 0 },
  ]),
});

const WEAPON_GROUP_DIALOG_TITLE_KEY = Object.freeze({
  features: 'SPACEHOLDER.ItemWeapon.DialogFeaturesTitle',
  projectile: 'SPACEHOLDER.ItemWeapon.DialogProjectileTitle',
  usage: 'SPACEHOLDER.ItemWeapon.DialogUsageTitle',
});

const AMMO_GROUP_DIALOG_TITLE_KEY = Object.freeze({
  projectile: 'SPACEHOLDER.ItemWeapon.DialogAmmoProjectileTitle',
  resource: 'SPACEHOLDER.ItemWeapon.DialogAmmoResourceTitle',
});

/**
 * @param {boolean} v
 * @returns {string}
 */
function _shFormatBool(v) {
  return v
    ? game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.Yes') ?? 'Yes'
    : game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.No') ?? 'No';
}

function _shFormatText(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : '—';
}

function _shFormatNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function _shFormatTags(v) {
  if (!Array.isArray(v) || v.length === 0) return '—';
  return v.join(', ');
}

/**
 * Build display rows for a panel given a field schema and the data object.
 * @param {ReadonlyArray<object>} fields
 * @param {object} data
 * @returns {Array<{label: string, display: string, text: boolean, multiline: boolean}>}
 */
function _shBuildRows(fields, data) {
  return fields.map((f) => {
    const value = data?.[f.name];
    let display;
    let text = false;
    let multiline = false;
    switch (f.kind) {
      case 'bool':
        display = _shFormatBool(!!value);
        break;
      case 'text':
        display = _shFormatText(value);
        text = true;
        break;
      case 'tags':
        display = _shFormatTags(value);
        text = true;
        multiline = true;
        break;
      case 'int':
      case 'number':
      default:
        display = _shFormatNumber(value);
    }
    return {
      label: game.i18n?.localize?.(f.labelKey) ?? f.labelKey,
      display,
      text,
      multiline,
    };
  });
}

/**
 * Build dialog field descriptors from a field schema and a data object.
 * @param {ReadonlyArray<object>} fields
 * @param {object} data
 * @returns {Array<object>}
 */
function _shBuildDialogFields(fields, data) {
  return fields.map((f) => {
    const raw = data?.[f.name];
    let value;
    if (f.kind === 'bool') value = !!raw;
    else if (f.kind === 'tags') value = Array.isArray(raw) ? raw.join(', ') : '';
    else if (f.kind === 'int' || f.kind === 'number') {
      const n = Number(raw);
      value = Number.isFinite(n) ? n : 0;
    } else value = String(raw ?? '');
    return {
      name: f.name,
      label: game.i18n?.localize?.(f.labelKey) ?? f.labelKey,
      kind: f.kind,
      value,
      placeholder: f.placeholderKey ? game.i18n?.localize?.(f.placeholderKey) ?? '' : '',
      hint: f.hintKey ? game.i18n?.localize?.(f.hintKey) ?? '' : '',
      min: f.min ?? '',
    };
  });
}

/**
 * Read a universal group dialog form back into a plain data object.
 * @param {HTMLElement|null} root
 * @param {ReadonlyArray<object>} fields
 * @returns {object}
 */
function _shReadDialogForm(root, fields) {
  const out = {};
  for (const f of fields) {
    const el = root?.querySelector?.(`[name="${f.name}"]`);
    if (!el) continue;
    if (f.kind === 'bool') {
      out[f.name] = !!el.checked;
    } else if (f.kind === 'tags') {
      const text = String(el.value ?? '');
      out[f.name] = text
        .split(/[,\n\r]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (f.kind === 'int') {
      const raw = String(el.value ?? '').trim();
      if (raw === '') {
        out[f.name] = f.min ?? 0;
      } else {
        const n = Math.floor(Number(raw));
        out[f.name] = Number.isFinite(n) ? Math.max(f.min ?? -Infinity, n) : f.min ?? 0;
      }
    } else if (f.kind === 'number') {
      const raw = String(el.value ?? '').trim();
      if (raw === '') {
        out[f.name] = 0;
      } else {
        const n = Number(raw);
        out[f.name] = Number.isFinite(n) ? n : 0;
      }
    } else {
      out[f.name] = String(el.value ?? '').trim();
    }
  }
  return out;
}

// Base V2 Item Sheet with Handlebars rendering
export class SpaceHolderBaseItemSheet extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheet
) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    classes: ['spaceholder', 'sheet', 'item'],
    position: { width: 520, height: 480 },
    window: {
      resizable: true,
      contentClasses: ['standard-form'],
    },
    form: {
      submitOnChange: true,
    },
  }, { inplace: false });

  // Native tabs configuration (Application V2)
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'attributes' },
        { id: 'actions' },
        { id: 'effects' }
      ],
      initial: 'description'
    }
  };

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const tabId = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    try { this.changeTab(tabId, 'primary', { updatePosition: false }); } catch (e) { /* ignore */ }
  }

  /** Сохраняем активную вкладку при переключении (как в листе персонажа). */
  changeTab(tab, group, options = {}) {
    if (group === 'primary') this._activeTabPrimary = tab;
    return super.changeTab(tab, group, options);
  }

  /** @inheritDoc */
  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    options.tab = { primary: this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description' };
  }

  /**
   * Текущее имя из поля формы (ещё не ушедшее в документ до submit) — нужно при programmatic update + render.
   * В ItemSheet V2 поле часто внутри `this.form`, а не всего `this.element`.
   * @param {HTMLFormElement|HTMLElement|null} [formOverride] — форма из `_prepareSubmitData`
   * @returns {string|null}
   */
  _getPendingNameFromForm(formOverride = null) {
    const roots = [];
    const add = (r) => {
      if (r instanceof HTMLElement && !roots.includes(r)) roots.push(r);
    };
    add(formOverride);
    add(this.form);
    add(this.element?.querySelector?.('form'));
    add(this.element);

    for (const root of roots) {
      const input = root?.querySelector?.('input[name="name"]');
      if (!input) continue;
      const v = String(input.value ?? '').trim();
      if (v.length) return v;
    }
    return null;
  }

  /**
   * Количество из поля шапки (ещё не ушедшее в документ) — для частичного submit и programmatic update.
   * @param {HTMLFormElement|HTMLElement|null} [formOverride]
   * @returns {number|null} целое ≥ 0 или null, если поля нет / пусто / не число
   */
  _getPendingQuantityFromForm(formOverride = null) {
    const roots = [];
    const add = (r) => {
      if (r instanceof HTMLElement && !roots.includes(r)) roots.push(r);
    };
    add(formOverride);
    add(this.form);
    add(this.element?.querySelector?.('form'));
    add(this.element);

    for (const root of roots) {
      const input = root?.querySelector?.('input[name="system.quantity"]');
      if (!input) continue;
      const s = String(input.value ?? '').trim();
      if (s === '') return null;
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.floor(n));
    }
    return null;
  }

  /**
   * Собрать валидное имя до вызова super: внутри `super._prepareSubmitData` Foundry валидирует diff
   * до возврата — постобработка после super не успевает исправить `name: undefined`.
   */
  _resolveSubmitName(form, formData) {
    let pending = this._getPendingNameFromForm(form);
    if (!pending && formData && typeof formData.get === 'function') {
      const raw = formData.get('name');
      const s = raw != null ? String(raw).trim() : '';
      if (s) pending = s;
    }
    let resolved = pending;
    if (!resolved) {
      resolved = String(this.item?.name ?? this.document?.name ?? '').trim() || null;
    }
    if (!resolved) {
      resolved = game.i18n?.localize?.('SPACEHOLDER.Inventory.NewItem') ?? 'New item';
    }
    return String(resolved);
  }

  /**
   * Валидное количество до merge в diff: DOM / FormData, иначе значение с документа.
   * @param {HTMLFormElement|null} form
   * @param {FormData} formData
   * @returns {number}
   */
  _resolveSubmitQuantity(form, formData) {
    const docRaw = Number(this.item?.system?.quantity);
    const docFallback = Number.isFinite(docRaw) ? Math.max(0, Math.floor(docRaw)) : 1;

    let pending = this._getPendingQuantityFromForm(form);
    if (pending === null && formData && typeof formData.get === 'function') {
      const raw = formData.get('system.quantity');
      if (raw != null && String(raw).trim() !== '') {
        const n = Number(String(raw).trim());
        if (Number.isFinite(n)) pending = Math.max(0, Math.floor(n));
      }
    }
    return pending !== null ? pending : docFallback;
  }

  /**
   * При submitOnChange ядро иногда передаёт в update только изменённые поля; без `name` падает валидация DataModel.
   * Непустое имя из DOM / FormData имеет приоритет (частичный submit не должен затирать ввод в шапке).
   * @inheritDoc
   */
  async _prepareSubmitData(event, form, formData) {
    const resolvedName = this._resolveSubmitName(form, formData);

    if (form instanceof HTMLFormElement) {
      const nameInput = form.querySelector('input[name="name"]');
      if (nameInput && !String(nameInput.value ?? '').trim()) {
        nameInput.value = resolvedName;
      }
    }
    try {
      if (formData && typeof formData.set === 'function') {
        const cur = formData.get('name');
        if (cur === undefined || cur === null || String(cur).trim() === '') {
          formData.set('name', resolvedName);
        }
      }
    } catch (_) {
      /* ignore */
    }

    const data = await Promise.resolve(super._prepareSubmitData(event, form, formData));
    if (!data || typeof data !== 'object') return data;

    const n = data.name;
    if (n === undefined || n === null || String(n).trim() === '') {
      data.name = resolvedName;
    } else {
      data.name = String(n).trim();
    }

    if (this.item?.type === 'item') {
      const resolvedQty = this._resolveSubmitQuantity(form, formData);
      data['system.quantity'] = resolvedQty;
      if (data.system && typeof data.system === 'object' && !Array.isArray(data.system)) {
        data.system.quantity = resolvedQty;
      }
    }

    return data;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Как у актёра (`context.actor = this.actor`): в шаблоне `{{item.name}}` и `item.uuid`
    // должны идти от живого документа — базовый контекст V2 иногда даёт plain object без имени.
    context.item = this.item;
    context.editable = this.isEditable;

    const itemData = this.document.toObject(false);

    // Enrich description info for display
    context.enrichedDescription = await enrichHTMLWithFactionIcons(this.item.system.description, {
      secrets: this.document.isOwner,
      async: true,
      rollData: this.item.getRollData(),
      relativeTo: this.item,
    });

    context.system = itemData.system;
    context.flags = itemData.flags;

    const defIcon = Item?.DEFAULT_ICON ?? '';
    const rawImg = this.item?.img ?? '';
    context.itemImgSrc = String(rawImg ?? '').trim() ? rawImg : defIcon;

    const itemType = String(this.item?.type ?? 'item');
    context.itemHeaderAccent = this._resolveItemHeaderAccentHex(itemType);
    const typeLabelKey = ITEM_TYPE_LABEL_KEYS[itemType] || ITEM_TYPE_LABEL_KEYS.item;
    context.itemTypeLabel = game.i18n?.localize?.(typeLabelKey) ?? itemType;
    context.itemTypeIconClass = ITEM_TYPE_ICON_CLASS[itemType] || ITEM_TYPE_ICON_CLASS.item;
    context.itemHeaderInlineQuantity = false;

    context.config = CONFIG.SPACEHOLDER;

    context.effects = prepareActiveEffectCategories(this.item.effects);

    // Defaults for older items
    context.system.actions = this._normalizeItemActions(context.system.actions);
    context.actionPayloadOptions = await this._getActionPayloadOptions();
    if (this.item.type === 'item') {
      context.system.defaultActions = context.system.defaultActions || {};
      context.system.defaultActions.equip = context.system.defaultActions.equip || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.unequip = context.system.defaultActions.unequip || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.hold = context.system.defaultActions.hold || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.stow = context.system.defaultActions.stow || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.drop = context.system.defaultActions.drop || { showInCombat: false, showInQuickbar: false };
      context.system.defaultActions.wear = context.system.defaultActions.wear || { showInCombat: false, showInQuickbar: false };
      context.system.defaultActions.show = context.system.defaultActions.show || { showInCombat: false, showInQuickbar: false };
    }

    const primaryTabDefs = this.constructor.TABS?.primary?.tabs ?? [];
    const primaryTabIds = primaryTabDefs.map((t) => t.id).filter(Boolean);
    context.sheetPrimaryTabs = buildItemSheetPrimaryTabs(primaryTabIds);

    return context;
  }

  async _getActionPayloadOptions() {
    try {
      let manager = game.spaceholder?.aimingManager ?? null;
      if (!manager) {
        const mod = await import('../helpers/aiming-manager.mjs');
        const Ctor = mod?.AimingManager;
        if (typeof Ctor === 'function') manager = new Ctor();
        if (manager && game.spaceholder) game.spaceholder.aimingManager = manager;
      }
      const payloads = await manager?.getPayloadLibrary?.();
      if (!Array.isArray(payloads)) return [];
      return payloads
        .map((p) => ({
          id: String(p?.id ?? '').trim(),
          name: String(p?.name ?? p?.id ?? '').trim(),
        }))
        .filter((p) => p.id);
    } catch (_) {
      return [];
    }
  }

  _newActionId() {
    try { return foundry.utils.randomID?.(); } catch (_) { /* ignore */ }
    try { return globalThis.randomID?.(); } catch (_) { /* ignore */ }
    try { return globalThis.crypto?.randomUUID?.(); } catch (_) { /* ignore */ }
    return String(Date.now());
  }

  _normalizeItemAction(action = {}, { keepId = true } = {}) {
    const modeRaw = String(action?.mode ?? 'chat').trim();
    const mode = Object.prototype.hasOwnProperty.call(ITEM_ACTION_MODE_LABEL_KEYS, modeRaw) ? modeRaw : 'chat';
    const normalized = {
      id: keepId ? String(action?.id ?? '').trim() : '',
      name: String(action?.name ?? '').trim(),
      apCost: Math.max(0, Math.floor(Number(action?.apCost) || 0)),
      mode,
      macro: String(action?.macro ?? ''),
      aimingType: String(action?.aimingType ?? 'simple').trim() || 'simple',
      payloadId: String(action?.payloadId ?? '').trim(),
      damage: Math.max(0, Number(action?.damage) || 0),
      requiresHolding: !!action?.requiresHolding,
      showInCombat: action?.showInCombat !== false,
      showInQuickbar: action?.showInQuickbar !== false,
      modeLabelKey: ITEM_ACTION_MODE_LABEL_KEYS[mode] || ITEM_ACTION_MODE_LABEL_KEYS.chat,
    };
    if (!keepId) normalized.id = '';
    return normalized;
  }

  _normalizeItemActions(actions) {
    const list = Array.isArray(actions) ? actions : [];
    return list.map((a) => this._normalizeItemAction(a, { keepId: true }));
  }

  _readActionDialogForm(root, baseAction = null) {
    const read = (selector) => root?.querySelector?.(selector);
    const actionId = String(baseAction?.id ?? '').trim() || this._newActionId();
    const next = this._normalizeItemAction({
      id: actionId,
      name: read('[name="name"]')?.value ?? '',
      apCost: read('[name="apCost"]')?.value ?? 0,
      mode: read('[name="mode"]')?.value ?? 'chat',
      macro: read('[name="macro"]')?.value ?? '',
      payloadId: read('[name="payloadId"]')?.value ?? '',
      aimingType: read('[name="aimingType"]')?.value ?? 'simple',
      damage: read('[name="damage"]')?.value ?? 0,
      requiresHolding: !!read('[name="requiresHolding"]')?.checked,
      showInCombat: !!read('[name="showInCombat"]')?.checked,
      showInQuickbar: !!read('[name="showInQuickbar"]')?.checked,
    }, { keepId: true });

    if (!next.name) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.NameRequired') ?? 'Action name is required');
      return null;
    }
    return next;
  }

  _bindActionDialogModeVisibility(dialogUid) {
    const root = document.querySelector(`[data-sh-item-action-dialog="${dialogUid}"]`);
    if (!root) return false;
    if (root.dataset.spaceholderModeBound) return true;
    root.dataset.spaceholderModeBound = '1';

    const modeSelect = root.querySelector('[data-sh-mode-select]');
    if (!(modeSelect instanceof HTMLSelectElement)) return true;
    const refresh = () => {
      const mode = String(modeSelect.value ?? 'chat').trim() || 'chat';
      root.querySelectorAll('[data-sh-mode-block]').forEach((block) => {
        const blockMode = String(block.getAttribute('data-sh-mode-block') ?? '').trim();
        block.hidden = !!blockMode && blockMode !== mode;
      });
    };
    modeSelect.addEventListener('change', refresh);
    refresh();
    return true;
  }

  async _openItemActionDialog({ title, action = null } = {}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable');
      return null;
    }

    const dialogUid = this._newActionId();
    const draftAction = this._normalizeItemAction(action, { keepId: true });
    const content = await foundry.applications.handlebars.renderTemplate('systems/spaceholder/templates/item/parts/item-action-dialog.hbs', {
      dialogUid,
      action: draftAction,
      modeOptions: Object.entries(ITEM_ACTION_MODE_LABEL_KEYS).map(([id, labelKey]) => ({ id, labelKey })),
      payloadOptions: Array.isArray(this._context?.actionPayloadOptions) ? this._context.actionPayloadOptions : [],
    });

    let outcome = null;
    const bindTimer = globalThis.setInterval?.(() => {
      if (this._bindActionDialogModeVisibility(dialogUid)) {
        globalThis.clearInterval?.(bindTimer);
      }
    }, 40);
    globalThis.setTimeout?.(() => globalThis.clearInterval?.(bindTimer), 2500);

    const titleText = title || game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.EditAction') || 'Edit action';
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: { title: titleText, icon: 'fa-solid fa-bolt' },
      position: { width: 520 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget;
            outcome = this._readActionDialogForm(root, draftAction);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });

    return outcome;
  }

  async _setItemActions(nextActions) {
    const patch = { 'system.actions': this._normalizeItemActions(nextActions) };
    const pending = this._getPendingNameFromForm();
    if (pending && pending !== String(this.item.name ?? '').trim()) patch.name = pending;
    const pendingQty = this._getPendingQuantityFromForm();
    if (pendingQty !== null) {
      const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
      if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
    }
    await this.item.update(patch);
  }

  /**
   * Клик по портрету предмета: FilePicker / просмотр (как SpaceHolderBaseActorSheet).
   * @private
   */
  async _onProfileImageClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const imgEl = event.currentTarget;
    const field = imgEl?.dataset?.edit || 'img';

    if (!this.isEditable) {
      const src = foundry.utils.getProperty(this.document, field) ?? this.document?.img;
      if (src && typeof ImagePopout === 'function') {
        new ImagePopout(src, { title: this.document?.name ?? 'Image' }).render(true);
      }
      return;
    }

    const Picker = globalThis.FilePicker;
    if (typeof Picker !== 'function') {
      ui.notifications?.warn?.('FilePicker недоступен');
      return;
    }

    const current = foundry.utils.getProperty(this.document, field) ?? this.document?.img ?? '';
    const fp = new Picker({
      type: 'image',
      current,
      callback: async (path) => {
        await this.document.update({ [field]: path });
      },
    });

    fp.render(true);
  }

  /**
   * Иконка из библиотеки SVG (только поле `img` предмета).
   * @private
   */
  async _onItemIconPickClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;

    const initialPath = String(this.item?.img ?? '').trim() || null;
    const title = game.i18n?.localize?.('SPACEHOLDER.IconPicker.Title') ?? null;
    const path = await pickIcon({ initialPath, defaultColor: '#ffffff', title: title || undefined });
    if (!path) return;

    try {
      await this.item.update({ img: path });
    } catch (e) {
      console.error('SpaceHolder | item icon pick update failed', e);
    }
    try {
      this.render(false);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Акцент шапки предмета по типу документа (детерминированный оттенок).
   * @param {string} itemType
   * @returns {string}
   * @protected
   */
  _resolveItemHeaderAccentHex(itemType) {
    const hue = this._hashStringToHue(String(itemType ?? 'item'));
    const hex = this._hslToHex(hue, 52, 44);
    return `#${hex.toString(16).padStart(6, '0')}`;
  }

  /** @private */
  _hashStringToHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 360;
  }

  /** @private */
  _hslToHex(h, s, l) {
    const sat = (s ?? 0) / 100;
    const lig = (l ?? 0) / 100;
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lig - c / 2;

    let r = 0; let g = 0; let b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    const to255 = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
    const rr = to255(r);
    const gg = to255(g);
    const bb = to255(b);
    return (rr << 16) + (gg << 8) + bb;
  }

  /**
   * У `<prose-mirror toggled>` превью строится из `enrichedDescription` при рендере.
   * В App V2 после `save` поле формы не всегда успевает попасть в документ до `_prepareContext`;
   * синхронизируем `system.description` из `el.value` и перерисовываем лист.
   */
  _bindDescriptionProseMirrorRefresh() {
    const el = this.element?.querySelector?.('prose-mirror[name="system.description"]');
    if (!el || el.dataset.spaceholderDescSaveBound === '1') return;
    el.dataset.spaceholderDescSaveBound = '1';

    el.addEventListener('save', async () => {
      let raw = '';
      try {
        const v = el.value;
        raw = typeof v === 'string' ? v : (v != null ? String(v) : '');
      } catch (_) {
        raw = '';
      }
      try {
        await this.item.update({ 'system.description': raw });
      } catch (e) {
        console.error('SpaceHolder | item description sync failed:', e);
        return;
      }
      await this.render(false);
    });
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    // Портрет: в ItemSheetV2 data-edit="img" не всегда обрабатывается — как на листе актёра
    const profileHandler = (this._onProfileImageClickBound ??= this._onProfileImageClick.bind(this));
    this.element?.querySelectorAll('img.profile-img[data-edit], img.profile-img').forEach((img) => {
      img.addEventListener('click', profileHandler);
    });

    const iconPickHandler = this._onItemIconPickClickBound ??= this._onItemIconPickClick.bind(this);
    this.element?.querySelectorAll('[data-action="sh-icon-pick"]').forEach((btn) => {
      btn.addEventListener('click', iconPickHandler);
    });

    // Повторно применяем активную вкладку после каждого рендера (как в листе персонажа)
    const desiredTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    try { this.changeTab(desiredTab, 'primary', { updatePosition: false, force: true }); } catch (e) { /* ignore */ }

    this._bindDescriptionProseMirrorRefresh();

    if (!this.isEditable) return;

    // Имя: надёжно пишем в документ на blur/change (submitOnChange + this.form не всегда совпадают с this.element)
    this.element.querySelectorAll('input[name="name"]').forEach((input) => {
      if (input.dataset.spaceholderNameBound) return;
      input.dataset.spaceholderNameBound = '1';
      const syncName = async () => {
        const v = String(input.value ?? '').trim();
        if (!v) return;
        const cur = String(this.item.name ?? '').trim();
        if (v === cur) return;
        try {
          await this.item.update({ name: v });
        } catch (e) {
          console.error('SpaceHolder | item name sync failed:', e);
        }
      };
      input.addEventListener('change', () => {
        syncName();
      });
      input.addEventListener('blur', () => {
        syncName();
      });
    });

    this.element.querySelectorAll('input[name="system.quantity"]').forEach((input) => {
      if (input.dataset.spaceholderQtyBound) return;
      input.dataset.spaceholderQtyBound = '1';
      const syncQty = async () => {
        const s = String(input.value ?? '').trim();
        if (s === '') return;
        const n = Math.max(0, Math.floor(Number(s)));
        if (!Number.isFinite(n)) return;
        const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
        if (n === cur) return;
        try {
          await this.item.update({ 'system.quantity': n });
        } catch (e) {
          console.error('SpaceHolder | item quantity sync failed:', e);
        }
      };
      input.addEventListener('change', syncQty);
      input.addEventListener('blur', syncQty);
    });

    // Active Effect management
    this.element.querySelectorAll('.effect-control').forEach(btn =>
      btn.addEventListener('click', (ev) => onManageActiveEffect(ev, this.item))
    );

    // Custom actions editor (item.system.actions): compact list + modal edit
    const el = this.element;
    const getActions = () => this._normalizeItemActions(this.item?.system?.actions);

    el.querySelectorAll('[data-action="sh-item-custom-action-add"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const created = await this._openItemActionDialog({
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.AddAction') ?? 'Add action',
          action: {
            id: this._newActionId(),
            name: '',
            apCost: 0,
            mode: 'chat',
            macro: '',
            aimingType: 'simple',
            payloadId: '',
            damage: 0,
            requiresHolding: false,
            showInCombat: true,
            showInQuickbar: true,
          },
        });
        if (!created) return;
        await this._setItemActions([...getActions(), created]);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-edit-open"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const source = getActions().find((a) => String(a?.id ?? '') === id);
        if (!source) return;
        const edited = await this._openItemActionDialog({
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.EditAction') ?? 'Edit action',
          action: source,
        });
        if (!edited) return;
        const next = getActions().map((a) => (String(a?.id ?? '') === id ? edited : a));
        await this._setItemActions(next);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-duplicate"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const source = getActions().find((a) => String(a?.id ?? '') === id);
        if (!source) return;
        const duplicateSuffix = game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DuplicateSuffix') ?? 'Copy';
        const cloned = await this._openItemActionDialog({
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DuplicateAction') ?? 'Duplicate action',
          action: {
            ...source,
            id: this._newActionId(),
            name: source.name ? `${source.name} (${duplicateSuffix})` : '',
          },
        });
        if (!cloned) return;
        await this._setItemActions([...getActions(), cloned]);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-remove"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionTitle') ?? 'Delete action',
            icon: 'fa-solid fa-trash',
          },
          content: `<p>${game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionConfirm') ?? 'Delete this action?'}</p>`,
          yes: { label: game.i18n?.localize?.('SPACEHOLDER.Actions.Delete') ?? 'Delete', icon: 'fa-solid fa-trash' },
          no: { label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel', icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        const next = getActions().filter((a) => String(a?.id ?? '') !== id);
        await this._setItemActions(next);
      });
    });
  }
}

// Item sheets per type (Application V2)
export class SpaceHolderItemSheet_Feature extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-feature-sheet.hbs' } };
}
export class SpaceHolderItemSheet_Spell extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-spell-sheet.hbs' } };
}
export class SpaceHolderItemSheet_Generic extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-sheet.hbs' } };
}

/**
 * Material item sheet — describes per-damage-type resistance, wear,
 * transmission and degradation overrides plus base metadata used by the
 * damage resolver.
 */
export class SpaceHolderItemSheet_Material extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-material-sheet.hbs' } };

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    position: { width: 720, height: 760 },
    window: Object.assign({}, super.DEFAULT_OPTIONS?.window, { resizable: true }),
  }, { inplace: false });

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sys = context.system || {};
    const damageTypes = CONFIG?.SPACEHOLDER?.damageTypes ?? {};
    const degradationModes = CONFIG?.SPACEHOLDER?.degradationModes ?? {};

    const conductance = (sys.conductance && typeof sys.conductance === 'object') ? sys.conductance : {};
    const selfInduction = (sys.selfInduction && typeof sys.selfInduction === 'object') ? sys.selfInduction : {};
    const degradation = (sys.degradation && typeof sys.degradation === 'object') ? sys.degradation : {};
    const resistance = (sys.resistance && typeof sys.resistance === 'object') ? sys.resistance : {};
    const wear = (sys.wear && typeof sys.wear === 'object') ? sys.wear : {};

    const asJsonString = (raw) => {
      if (Array.isArray(raw)) {
        try { return JSON.stringify(raw); } catch (_) { return ''; }
      }
      return typeof raw === 'string' ? raw : '';
    };

    context.materialDamageRows = Object.values(damageTypes).map((dt) => ({
      id: dt.id,
      labelKey: dt.label,
      descriptionKey: dt.description,
      category: dt.category,
      resistance: Number(resistance[dt.id] ?? 0),
      wear: Number(wear[dt.id] ?? 0),
      conductanceJson: asJsonString(conductance[dt.id]),
      selfInductionJson: asJsonString(selfInduction[dt.id]),
      degradation: typeof degradation[dt.id] === 'string' ? degradation[dt.id] : '',
    }));

    context.degradationOptions = Object.entries(degradationModes).map(([_key, value]) => ({
      id: value,
      labelKey: `SPACEHOLDER.Degradation.${value.charAt(0).toUpperCase()}${value.slice(1)}`,
    }));

    const currentCategory = String(sys.category ?? 'metal');
    context.materialCategoryOptions = MATERIAL_CATEGORY_OPTIONS.map((opt) => ({
      ...opt,
      selected: opt.id === currentCategory,
    }));

    return context;
  }

  /**
   * Allow per-damage-type conductance / self-induction rows to be authored
   * as JSON strings in text inputs. Convert them back to arrays before
   * persisting; invalid JSON keeps the previous value to avoid wiping user
   * data on a typo.
   * @inheritDoc
   */
  _prepareSubmitData(event, form, formData) {
    const data = super._prepareSubmitData(event, form, formData);
    const hardness = data?.system?.hardness;
    if (hardness && typeof hardness === 'object') {
      const values = Object.values(hardness)
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);
      data.system.hardness = values.length ? Math.max(...values) : 1;
    }
    const normalizeFractionGroup = (group, prevGroup) => {
      if (!group || typeof group !== 'object') return;
      for (const [key, raw] of Object.entries(group)) {
        if (Array.isArray(raw)) continue;
        const text = String(raw ?? '').trim();
        if (!text) {
          group[key] = [];
          continue;
        }
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) group[key] = parsed;
          else group[key] = Array.isArray(prevGroup?.[key]) ? prevGroup[key] : [];
        } catch (_) {
          group[key] = Array.isArray(prevGroup?.[key]) ? prevGroup[key] : [];
        }
      }
    };
    normalizeFractionGroup(data?.system?.conductance, this.document?.system?.conductance);
    normalizeFractionGroup(data?.system?.selfInduction, this.document?.system?.selfInduction);

    const degGroup = data?.system?.degradation;
    if (degGroup && typeof degGroup === 'object') {
      for (const [key, raw] of Object.entries(degGroup)) {
        const value = String(raw ?? '').trim();
        if (!value) delete degGroup[key];
      }
    }
    return data;
  }
}

/**
 * Item sheet (gear: anatomy coverage, equip, modifiers, optional roll formula).
 */
export class SpaceHolderItemSheet_Item extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-wearable-sheet.hbs' } };

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    // Шапка + полоса вкладок + баннер + строка управления + фиксированный ряд 420px (покрытие)
    position: { width: 720, height: 860 },
    window: Object.assign({}, super.DEFAULT_OPTIONS?.window, { resizable: true }),
  });

  // Вкладки: описание → ближнее / дальнее / метательное / боеприпас (по тегам) → прочее → настройки последние.
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'melee' },
        { id: 'ranged' },
        { id: 'thrown' },
        { id: 'ammo' },
        { id: 'attributes' },
        { id: 'actions' },
        { id: 'modifiers' },
        { id: 'container' },
        { id: 'tags' },
      ],
      initial: 'description',
    },
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const system = context.system || {};

    // itemTags: булевы флаги групп механик (см. template.json / migrateData)
    const rawTags = system.itemTags && typeof system.itemTags === 'object' ? system.itemTags : {};
    const legacyWeapon = !!rawTags.isWeapon;
    const hadAnyWeaponKind = !!(rawTags.isMelee || rawTags.isRanged || rawTags.isThrown);
    if (!system.itemTags || typeof system.itemTags !== 'object') {
      system.itemTags = {
        isArmor: false,
        isActions: false,
        isModifiers: false,
        isMelee: false,
        isRanged: false,
        isThrown: false,
        isAmmo: false,
        isContainer: false,
      };
    } else {
      system.itemTags = {
        isArmor: !!rawTags.isArmor,
        isActions: !!rawTags.isActions,
        isModifiers: !!rawTags.isModifiers,
        isMelee: !!(rawTags.isMelee || (legacyWeapon && !hadAnyWeaponKind)),
        isRanged: !!rawTags.isRanged,
        isThrown: !!rawTags.isThrown,
        isAmmo: !!rawTags.isAmmo,
        isContainer: !!rawTags.isContainer,
      };
    }
    context.hasArmorTag = system.itemTags.isArmor;
    context.hasActionsTag = system.itemTags.isActions;
    context.hasModifiersTag = system.itemTags.isModifiers;
    context.hasMeleeTag = system.itemTags.isMelee;
    context.hasRangedTag = system.itemTags.isRanged;
    context.hasThrownTag = system.itemTags.isThrown;
    context.hasAmmoTag = system.itemTags.isAmmo;
    context.hasContainerTag = system.itemTags.isContainer;

    const allowedTabs = new Set(['description', 'tags']);
    if (system.itemTags.isArmor) allowedTabs.add('attributes');
    if (system.itemTags.isActions) allowedTabs.add('actions');
    if (system.itemTags.isModifiers) allowedTabs.add('modifiers');
    if (system.itemTags.isMelee) allowedTabs.add('melee');
    if (system.itemTags.isRanged) allowedTabs.add('ranged');
    if (system.itemTags.isThrown) allowedTabs.add('thrown');
    if (system.itemTags.isAmmo) allowedTabs.add('ammo');
    if (system.itemTags.isContainer) allowedTabs.add('container');
    let currentTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    if (currentTab === 'weapon') {
      if (system.itemTags.isMelee) currentTab = 'melee';
      else if (system.itemTags.isRanged) currentTab = 'ranged';
      else if (system.itemTags.isThrown) currentTab = 'thrown';
      else currentTab = 'description';
      this._activeTabPrimary = currentTab;
    }
    if (!allowedTabs.has(currentTab)) {
      this._activeTabPrimary = 'tags';
    }

    const selectedAnatomyId = String(system.anatomyId ?? '').trim() || null;
    context.selectedAnatomyId = selectedAnatomyId;
    const fallbackAnatomyId = String(CONFIG?.SPACEHOLDER?.wearableCoverageReferenceAnatomyId ?? '').trim() || null;
    let editorAnatomyId = selectedAnatomyId || fallbackAnatomyId;
    if (!editorAnatomyId) {
      const availableIds = Object.keys(anatomyManager.getAvailableAnatomies() ?? {});
      if (availableIds.length) editorAnatomyId = availableIds[0];
    }

    // Название анатомии + список частей для выбранного эталона предмета
    context.anatomyDisplayName = null;
    context.bodyPartsForGroup = [];

    const coveredParts = Array.isArray(system.coveredParts) ? system.coveredParts : [];

    if (editorAnatomyId) {
      try {
        let anatomyData = null;
        const registryInfo = anatomyManager.getAnatomyInfo(editorAnatomyId);
        if (registryInfo) {
          anatomyData = await anatomyManager.loadAnatomy(editorAnatomyId);
          if (selectedAnatomyId) {
            context.anatomyDisplayName = anatomyManager.getAnatomyDisplayName(selectedAnatomyId);
          }
        } else {
          await anatomyManager.loadWorldPresets();
          const worldPresets = anatomyManager.getWorldPresets();
          const preset = worldPresets.find((p) => p.id === editorAnatomyId);
          if (preset) {
            anatomyData = preset;
            if (selectedAnatomyId) {
              context.anatomyDisplayName = preset.name || preset.id;
            }
          }
        }

        const parts = anatomyData?.bodyParts ?? {};
        if (Object.keys(parts).length) {
          context.anatomyDataForEditor = {
            bodyParts: parts,
            grid: anatomyData.grid ?? {}
          };

          // Построим детерминированный список экземпляров для UI
          const byTypeId = new Map();
          for (const [slotRef, part] of Object.entries(parts)) {
            const typeId = String(part.id ?? slotRef ?? "").trim();
            if (!typeId) continue;
            const arr = byTypeId.get(typeId) || [];
            arr.push({ slotRef, part });
            byTypeId.set(typeId, arr);
          }

          const entries = [];
          for (const [typeId, arr] of byTypeId.entries()) {
            arr.sort((a, b) => {
              const ax = a.part.x ?? 0;
              const bx = b.part.x ?? 0;
              if (ax !== bx) return ax - bx;
              const ay = a.part.y ?? 0;
              const by = b.part.y ?? 0;
              if (ay !== by) return ay - by;
              return a.slotRef.localeCompare(b.slotRef);
            });
            arr.forEach((entry, index) => {
              const baseName = entry.part.displayName || entry.part.name || typeId;
              const duplicateIndex = arr.length > 1 ? index + 1 : null;
              const displayName = duplicateIndex ? `${baseName} (${duplicateIndex})` : baseName;
              entries.push({
                id: entry.slotRef,
                name: displayName
              });
            });
          }

          context.bodyPartsForGroup = entries.sort((a, b) => a.name.localeCompare(b.name, game.i18n?.lang || 'en'));
        }
      } catch (e) {
        console.error('SpaceHolder | Failed to prepare wearable body parts list:', e);
      }
    }

    if (!context.anatomyDisplayName) {
      context.anatomyDisplayName = game.i18n?.localize?.('SPACEHOLDER.Wearable.NoAnatomySelected') ?? '—';
    }

    // Режим редактирования покрытия (флаг на документе)
    context.wearableCoverageEditMode = !!this.document?.flags?.spaceholder?.wearableCoverageEditMode;

    // Список покрытых частей — из coveredParts; имена берём из анатомии, если есть
    const partsForNames = context.anatomyDataForEditor?.bodyParts ?? {};
    const countByTypeId = {};
    for (const p of Object.values(partsForNames)) {
      const typeId = String(p?.id ?? "").trim();
      if (!typeId) continue;
      countByTypeId[typeId] = (countByTypeId[typeId] || 0) + 1;
    }
    const localizePartName = (partId, fallback) => {
      const key = `SPACEHOLDER.BodyParts.${partId}`;
      const localized = game.i18n?.localize?.(key);
      if (localized && localized !== key) return localized;
      return fallback;
    };

    context.coveredList = coveredParts
      .map((entry) => {
        const slotRef = String(entry.slotRef ?? entry.partId ?? "").trim();
        if (!slotRef) return null;
        const part = partsForNames[slotRef];
        const canonicalId = String(part?.id ?? slotRef).trim() || slotRef;
        const baseNameRaw = part?.displayName || part?.name || canonicalId || slotRef;
        const baseName = localizePartName(canonicalId, baseNameRaw);
        const typeId = String(part?.id ?? "").trim();
        const hasDup = !!typeId && (countByTypeId[typeId] || 0) > 1;
        const m = String(slotRef).match(/#(\d+)$/);
        const dupIndex = hasDup && m ? Number(m[1]) : null;
        const uiName = dupIndex ? `${baseName} (${dupIndex})` : baseName;
        const layers = Array.isArray(entry?.layers) ? entry.layers : [];
        return {
          partId: slotRef,
          partName: uiName,
          layerCount: layers.length,
          layersSummary: formatCoverageLayersSummary(layers)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.partName.localeCompare(b.partName, game.i18n?.lang || 'en'));

    // Targets для модификаторов (используется на вкладке Modifiers)
    const cfgTargets = CONFIG.SPACEHOLDER?.characterModifierTargets || {};
    context.modifierTargets = {
      abilities: Array.isArray(cfgTargets.abilities) ? cfgTargets.abilities : [],
      derived: Array.isArray(cfgTargets.derived) ? cfgTargets.derived : [],
      params: Array.isArray(cfgTargets.params) ? cfgTargets.params : []
    };

    // Гарантируем наличие массивов модификаторов в системе предмета
    system.modifiers = system.modifiers || {};
    system.modifiers.abilities = Array.isArray(system.modifiers.abilities) ? system.modifiers.abilities : [];
    system.modifiers.derived = Array.isArray(system.modifiers.derived) ? system.modifiers.derived : [];
    system.modifiers.params = Array.isArray(system.modifiers.params) ? system.modifiers.params : [];

    // Layers are now per-coveredPart; the dialog opened via the
    // "wearable-coverage-layers" button handles material selection.

    // Оружейные вкладки: нормализованные данные (без подключения к стрельбе — только авторинг в предмете).
    system.storage = normalizeNestedStorage(system.storage);
    system.weapon = migrateItemWeaponData(system.weapon, system.itemTags);
    if (context.hasMeleeTag) this._buildWeaponChannelRows(system.weapon.melee, 'melee');
    if (context.hasRangedTag) this._buildWeaponChannelRows(system.weapon.ranged, 'ranged');
    if (context.hasThrownTag) this._buildWeaponChannelRows(system.weapon.thrown, 'thrown');
    if (context.hasAmmoTag) this._buildAmmoRows(system.weapon.ammo);

    const icFields = normalizeItemContainerFields(system);
    system.containerHostId = icFields.containerHostId;
    system.container = icFields.container;

    context.system = system;

    if (context.hasContainerTag) {
      const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
      context.containerOnActor = !!actor;
      context.containerWorldMode = !actor;
      context.containerReadOnly = !this.isEditable;
      const panel = await this._buildContainerPanelContext(actor);
      context.containerGear = panel.containerGear;
      context.containerTotalWeight = panel.containerTotalWeight;
      context.containerTotalItems = panel.containerTotalItems;
    }

    const wearableTabIds = ['description'];
    if (context.hasMeleeTag) wearableTabIds.push('melee');
    if (context.hasRangedTag) wearableTabIds.push('ranged');
    if (context.hasThrownTag) wearableTabIds.push('thrown');
    if (context.hasAmmoTag) wearableTabIds.push('ammo');
    if (context.hasArmorTag) wearableTabIds.push('attributes');
    if (context.hasActionsTag) wearableTabIds.push('actions');
    if (context.hasModifiersTag) wearableTabIds.push('modifiers');
    if (context.hasContainerTag) wearableTabIds.push('container');
    wearableTabIds.push('tags');
    context.sheetPrimaryTabs = buildItemSheetPrimaryTabs(wearableTabIds, {
      attributes: { icon: 'fas fa-shield-halved', labelKey: 'SPACEHOLDER.Tabs.Coverage' },
      tags: { icon: 'fas fa-gear', labelKey: 'SPACEHOLDER.Tabs.Settings' },
    });
    context.itemHeaderInlineQuantity = true;

    return context;
  }

  /**
   * Attach panel display rows to a channel object so the channel-tab template
   * can render group panels generically.
   * @param {object} ch
   * @param {'melee'|'ranged'|'thrown'} channelKey
   */
  _buildWeaponChannelRows(ch, channelKey) {
    if (!ch || typeof ch !== 'object') return;
    const schema = WEAPON_FIELD_SCHEMAS[channelKey];
    if (!schema) return;
    ch.featuresRows = _shBuildRows(schema.features, ch.features);
    ch.projectileRows = _shBuildRows(schema.projectile, ch.projectile);
    ch.usageRows = _shBuildRows(schema.usage, ch.usage);
    if (channelKey === 'ranged') ch.nestedStorage = this._buildNestedStorageSummary();
  }

  /**
   * Attach panel display rows to the ammo block.
   * @param {object} ammo
   */
  _buildAmmoRows(ammo) {
    if (!ammo || typeof ammo !== 'object') return;
    ammo.projectileRows = _shBuildRows(AMMO_FIELD_SCHEMAS.projectile, ammo.projectile);
    ammo.resourceRows = _shBuildRows(AMMO_FIELD_SCHEMAS.resource, ammo.resource);
  }

  _buildNestedStorageSummary() {
    const storage = normalizeNestedStorage(this.item?.system?.storage);
    const usage = this.item?.system?.weapon?.ranged?.usage ?? {};
    const contents = flattenNestedContents(storage).map(({ item, path }) => {
      const qty = Number(item?.system?.quantity ?? 0);
      const depth = Math.max(0, path.length - 1);
      const isAmmo = !!item?.system?.itemTags?.isAmmo;
      const childCount = normalizeNestedStorage(item?.system?.storage).contents.length;
      return {
        id: String(item?.id ?? ''),
        path: path.join('/'),
        depth,
        name: String(item?.name ?? ''),
        type: String(item?.type ?? ''),
        quantity: Number.isFinite(qty) ? qty : 0,
        isAmmo,
        childCount,
        isAttached: String(path[0] ?? '') === String(storage.slots.attachedContainerId || usage.attachedContainerId || ''),
        isChamber: String(path[path.length - 1] ?? '') === String(storage.slots.chamberItemId || usage.chamberCurrentId || ''),
      };
    });
    return {
      attachedContainerId: String(storage.slots.attachedContainerId || usage.attachedContainerId || ''),
      chamberItemId: String(storage.slots.chamberItemId || usage.chamberCurrentId || ''),
      feedSources: Object.values(NESTED_STORAGE_FEED_SOURCES).join(', '),
      contents,
    };
  }

  /**
   * @param {Actor|null} actor
   * @returns {Promise<{ containerGear: object[], containerTotalWeight: number, containerTotalItems: number }>}
   */
  async _buildContainerPanelContext(actor) {
    const empty = { containerGear: [], containerTotalWeight: 0, containerTotalItems: 0 };
    if (actor?.items) return this._buildActorContainerPanelContext(actor);
    return this._buildWorldContainerPanelContext();
  }

  /**
   * @param {Actor} actor
   * @returns {{ containerGear: object[], containerTotalWeight: number, containerTotalItems: number }}
   */
  _buildActorContainerPanelContext(actor) {
    const empty = { containerGear: [], containerTotalWeight: 0, containerTotalItems: 0 };
    if (!actor?.items) return empty;
    const hostId = String(this.item?.id ?? '').trim();
    if (!hostId) return empty;
    const { container } = normalizeItemContainerFields(this.item.system);
    const byId = new Map();
    for (const it of actor.items) byId.set(it.id, it);
    const rows = [];
    const seen = new Set();
    const pushRow = (it) => {
      if (!it || it.type !== 'item' || it.id === hostId) return;
      if (String(it.system?.containerHostId ?? '').trim() !== hostId) return;
      rows.push({
        entryKind: 'actor',
        _id: it.id,
        name: it.name,
        img: it.img || Item.DEFAULT_ICON,
        system: {
          description: it.system?.description,
          quantity: it.system?.quantity,
          weight: it.system?.weight,
        },
      });
      seen.add(it.id);
    };
    for (const entry of container.contents) {
      if (entry.kind !== ENTRY_ACTOR_ITEM) continue;
      pushRow(byId.get(entry.itemId));
    }
    for (const it of actor.items) {
      if (!seen.has(it.id)) pushRow(it);
    }
    let tw = 0;
    let ti = 0;
    for (const r of rows) {
      const q = Number(r.system?.quantity) || 0;
      const w = Number(r.system?.weight) || 0;
      ti += q;
      tw += w * q;
    }
    return {
      containerGear: rows,
      containerTotalWeight: Math.round(tw * 100) / 100,
      containerTotalItems: ti,
    };
  }

  /**
   * @returns {Promise<{ containerGear: object[], containerTotalWeight: number, containerTotalItems: number }>}
   */
  async _buildWorldContainerPanelContext() {
    const L = (k) => game.i18n?.localize?.(k) ?? k;
    const { container } = normalizeItemContainerFields(this.item.system);
    const rows = [];
    let tw = 0;
    let ti = 0;
    for (const entry of container.contents) {
      if (entry.kind !== ENTRY_WORLD_UUID) continue;
      let doc = null;
      try {
        doc = await fromUuid(entry.uuid);
      } catch (_) {
        doc = null;
      }
      if (!doc || doc.documentName !== 'Item') {
        rows.push({
          entryKind: 'world',
          worldUuid: entry.uuid,
          broken: true,
          name: L('SPACEHOLDER.ItemContainer.BrokenLink'),
          img: Item.DEFAULT_ICON,
          system: { description: '', quantity: 0, weight: 0 },
        });
        continue;
      }
      const q = Number(doc.system?.quantity) || 0;
      const w = Number(doc.system?.weight) || 0;
      ti += q;
      tw += w * q;
      rows.push({
        entryKind: 'world',
        worldUuid: entry.uuid,
        broken: false,
        name: doc.name,
        img: doc.img || Item.DEFAULT_ICON,
        system: {
          description: doc.system?.description,
          quantity: doc.system?.quantity,
          weight: doc.system?.weight,
        },
      });
    }
    return {
      containerGear: rows,
      containerTotalWeight: Math.round(tw * 100) / 100,
      containerTotalItems: ti,
    };
  }

  /**
   * Черновик для диалога варианта атаки (плоские поля для input).
   * @param {object} atk
   * @param {'melee'|'ranged'|'thrown'} channelKey
   * @returns {object}
   */
  _weaponAttackDialogDraft(atk, channelKey) {
    const a = atk && typeof atk === 'object' ? atk : {};
    const m = a.modifiers && typeof a.modifiers === 'object' ? a.modifiers : {};
    const o = a.overrides && typeof a.overrides === 'object' ? a.overrides : {};
    const numStr = (v) => (v === null || v === undefined ? '' : v);
    const triSel = (v) => (v === null || v === undefined ? '' : v ? '1' : '0');
    return {
      id: String(a.id ?? '').trim(),
      name: String(a.name ?? '').trim(),
      mode: String(a.mode ?? 'single').trim() || 'single',
      description: String(a.description ?? '').trim(),
      enabled: a.enabled !== false,
      isDefault: !!a.isDefault,
      origin: String(a.origin ?? 'manual').trim() || 'manual',
      channel: channelKey,
      m_apCostAdd: numStr(m.apCostAdd),
      m_accuracyAdd: numStr(m.accuracyAdd),
      m_recoilAdd: numStr(m.recoilAdd),
      m_damageAdd: numStr(m.damageAdd),
      m_projectilesPerUseAdd: numStr(m.projectilesPerUseAdd),
      m_damageMult: numStr(m.damageMult ?? 1),
      m_armorPenAdd: numStr(m.armorPenAdd),
      m_armorDamageFactorMult: numStr(m.armorDamageFactorMult ?? 1),
      m_hardnessMult: numStr(m.hardnessMult ?? 1),
      o_apCost: numStr(o.apCost),
      o_accuracy: numStr(o.accuracy),
      o_recoil: numStr(o.recoil),
      o_projectilesPerUse: numStr(o.projectilesPerUse),
      o_damage: numStr(o.damage),
      o_damageType: o.damageType === null || o.damageType === undefined ? '' : String(o.damageType),
      o_armorPen: numStr(o.armorPen),
      o_armorDamageFactor: numStr(o.armorDamageFactor),
      o_hardness: numStr(o.hardness),
      o_payloadId: o.payloadId === null || o.payloadId === undefined ? '' : String(o.payloadId),
      o_requiresReadyStateSel: triSel(o.requiresReadyState),
      o_requiresAimStateSel: triSel(o.requiresAimState),
    };
  }

  /**
   * @param {HTMLElement|null} root
   * @param {'melee'|'ranged'|'thrown'} channelKey
   * @param {string} [fallbackId]
   * @returns {object|null}
   */
  _readWeaponAttackDialogForm(root, channelKey, fallbackId = '') {
    const read = (name) => root?.querySelector?.(`[name="${name}"]`);
    const readVal = (name) => read(name)?.value;
    const readChecked = (name) => !!read(name)?.checked;
    const parseNum = (raw) => {
      const s = String(raw ?? '').trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const parseTri = (raw) => {
      const s = String(raw ?? '').trim();
      if (s === '') return null;
      if (s === '0') return false;
      if (s === '1') return true;
      return null;
    };

    let id = String(readVal('atkId') ?? '').trim() || String(fallbackId ?? '').trim();
    if (!id) id = this._newActionId();
    const name = String(readVal('atkName') ?? '').trim();
    if (!name) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.AttackNameRequired') ?? 'Attack name is required'
      );
      return null;
    }

    return {
      id,
      name,
      channel: channelKey,
      mode: String(readVal('atkMode') ?? 'single').trim() || 'single',
      description: String(readVal('atkDescription') ?? '').trim(),
      enabled: readChecked('atkEnabled'),
      isDefault: readChecked('atkIsDefault'),
      origin: String(readVal('atkOrigin') ?? 'manual').trim() || 'manual',
      modifiers: {
        apCostAdd: Number(readVal('m_apCostAdd') ?? 0) || 0,
        accuracyAdd: Number(readVal('m_accuracyAdd') ?? 0) || 0,
        recoilAdd: Number(readVal('m_recoilAdd') ?? 0) || 0,
        damageAdd: Number(readVal('m_damageAdd') ?? 0) || 0,
        projectilesPerUseAdd: Number(readVal('m_projectilesPerUseAdd') ?? 0) || 0,
        damageMult: Number(readVal('m_damageMult') ?? 1) || 1,
        armorPenAdd: Number(readVal('m_armorPenAdd') ?? 0) || 0,
        armorDamageFactorMult: Number(readVal('m_armorDamageFactorMult') ?? 1) || 1,
        hardnessMult: Number(readVal('m_hardnessMult') ?? 1) || 1,
      },
      overrides: {
        apCost: parseNum(readVal('o_apCost')),
        accuracy: parseNum(readVal('o_accuracy')),
        recoil: parseNum(readVal('o_recoil')),
        projectilesPerUse: parseNum(readVal('o_projectilesPerUse')),
        damage: parseNum(readVal('o_damage')),
        damageType: (() => {
          const s = String(readVal('o_damageType') ?? '').trim();
          return s === '' ? null : s;
        })(),
        armorPen: parseNum(readVal('o_armorPen')),
        armorDamageFactor: parseNum(readVal('o_armorDamageFactor')),
        hardness: parseNum(readVal('o_hardness')),
        payloadId: (() => {
          const s = String(readVal('o_payloadId') ?? '').trim();
          return s === '' ? null : s;
        })(),
        requiresReadyState: parseTri(readVal('o_requiresReadyState')),
        requiresAimState: parseTri(readVal('o_requiresAimState')),
      },
    };
  }

  /**
   * @param {object} opts
   * @param {string} opts.title
   * @param {'melee'|'ranged'|'thrown'} opts.channelKey
   * @param {object|null} [opts.action]
   * @returns {Promise<object|null>}
   */
  async _openWeaponAttackDialog({ title, channelKey, action = null } = {}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable'
      );
      return null;
    }

    const dialogUid = this._newActionId();
    const draft = this._weaponAttackDialogDraft(action, channelKey);
    const payloadOptions = await this._getActionPayloadOptions();
    const content = await foundry.applications.handlebars.renderTemplate('systems/spaceholder/templates/item/parts/item-weapon-attack-dialog.hbs', {
      dialogUid,
      attack: draft,
      payloadOptions,
    });

    let outcome = null;
    const titleText =
      title ||
      (game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.AddAttack') ?? 'Attack variant');

    await DialogV2.wait({
      classes: ['spaceholder'],
      window: { title: titleText, icon: 'fa-solid fa-crosshairs' },
      position: { width: 560 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget;
            outcome = this._readWeaponAttackDialogForm(root, channelKey, draft.id);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });

    return outcome;
  }

  /**
   * @param {HTMLElement|null} root
   * @returns {object}
   */
  _readWeaponChannelOptionsDialogForm(root) {
    const q = (n) => root?.querySelector?.(`[name="${n}"]`);
    const idRaw = String(q('wo_defaultAttackId')?.value ?? '').trim();
    return {
      defaultAttackId: idRaw.length ? idRaw : null,
      autoGenerateDefault: !!q('wo_autoGenerateDefault')?.checked,
    };
  }

  /**
   * Open the universal group editor for `weapon.<channel>.<group>`.
   * @param {'melee'|'ranged'|'thrown'} channelKey
   * @param {'features'|'projectile'|'usage'} groupKey
   */
  async _openWeaponGroupDialog(channelKey, groupKey) {
    const schema = WEAPON_FIELD_SCHEMAS[channelKey]?.[groupKey];
    if (!schema) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable'
      );
      return;
    }
    const ch = this.item.system.weapon?.[channelKey];
    const groupData = foundry.utils.duplicate(ch?.[groupKey] ?? {});
    const dialogUid = this._newActionId();
    const fields = _shBuildDialogFields(schema, groupData);
    const content = await foundry.applications.handlebars.renderTemplate(
      'systems/spaceholder/templates/item/parts/item-weapon-group-dialog.hbs',
      { dialogUid, fields }
    );
    const titleKey = WEAPON_GROUP_DIALOG_TITLE_KEY[groupKey];
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: {
        title: game.i18n?.localize?.(titleKey) ?? 'Weapon group',
        icon: 'fa-solid fa-pen-to-square',
      },
      position: { width: 440 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget?.closest?.('.window-content') ||
              (typeof document !== 'undefined'
                ? document.querySelector(`[data-sh-weapon-group-dialog="${dialogUid}"]`)
                : null);
            const next = _shReadDialogForm(root, schema);
            const w = this._getWeaponData();
            if (!w[channelKey] || typeof w[channelKey] !== 'object') w[channelKey] = {};
            w[channelKey][groupKey] = { ...(w[channelKey][groupKey] ?? {}), ...next };
            await this._setWeaponData(w);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });
  }

  /**
   * @param {'melee'|'ranged'|'thrown'} channelKey
   */
  async _openWeaponChannelOptionsDialog(channelKey) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable'
      );
      return;
    }
    const raw = this.item.system.weapon?.[channelKey];
    const ch = foundry.utils.duplicate(raw ?? {});
    ch.defaultAttackId = ch.defaultAttackId ?? '';
    ch.autoGenerateDefault = ch.autoGenerateDefault !== false;
    const dialogUid = this._newActionId();
    const content = await foundry.applications.handlebars.renderTemplate(
      'systems/spaceholder/templates/item/parts/item-weapon-channel-options-dialog.hbs',
      { dialogUid, ch, channelKey }
    );
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: {
        title:
          game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.DialogChannelOptionsTitle') ??
          'Channel options',
        icon: 'fa-solid fa-sliders',
      },
      position: { width: 420 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget?.closest?.('.window-content') ||
              (typeof document !== 'undefined'
                ? document.querySelector(`[data-sh-weapon-channel-options-dialog="${dialogUid}"]`)
                : null);
            const opts = this._readWeaponChannelOptionsDialogForm(root);
            const w = this._getWeaponData();
            if (!w[channelKey] || typeof w[channelKey] !== 'object') w[channelKey] = {};
            w[channelKey].defaultAttackId = opts.defaultAttackId;
            w[channelKey].autoGenerateDefault = opts.autoGenerateDefault;
            await this._setWeaponData(w);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });
  }

  /**
   * Open the universal group editor for `weapon.ammo.<group>`.
   * @param {'projectile'|'resource'} groupKey
   */
  async _openAmmoGroupDialog(groupKey) {
    const schema = AMMO_FIELD_SCHEMAS[groupKey];
    if (!schema) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable'
      );
      return;
    }
    const groupData = foundry.utils.duplicate(this.item.system.weapon?.ammo?.[groupKey] ?? {});
    const dialogUid = this._newActionId();
    const fields = _shBuildDialogFields(schema, groupData);
    const content = await foundry.applications.handlebars.renderTemplate(
      'systems/spaceholder/templates/item/parts/item-weapon-group-dialog.hbs',
      { dialogUid, fields }
    );
    const titleKey = AMMO_GROUP_DIALOG_TITLE_KEY[groupKey];
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: {
        title: game.i18n?.localize?.(titleKey) ?? 'Ammunition',
        icon: 'fa-solid fa-box',
      },
      position: { width: 440 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget?.closest?.('.window-content') ||
              (typeof document !== 'undefined'
                ? document.querySelector(`[data-sh-weapon-group-dialog="${dialogUid}"]`)
                : null);
            const next = _shReadDialogForm(root, schema);
            const w = this._getWeaponData();
            if (!w.ammo || typeof w.ammo !== 'object') w.ammo = {};
            w.ammo[groupKey] = { ...(w.ammo[groupKey] ?? {}), ...next };
            await this._setWeaponData(w);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });
  }

  _nestedPathFromText(text) {
    return String(text ?? '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async _openNestedStorageAddDialog() {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable'
      );
      return;
    }

    const dialogUid = this._newActionId();
    const content = `
      <div class="sh-item-action-dialog" data-sh-nested-storage-add-dialog="${dialogUid}">
        <div class="form-group">
          <label>${game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedItemUuid') ?? 'Item UUID'}</label>
          <div class="form-fields">
            <input type="text" name="uuid" autocomplete="off" placeholder="Actor.x.Item.y" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedQuantity') ?? 'Quantity'}</label>
          <div class="form-fields">
            <input type="number" name="quantity" min="1" step="1" value="1" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedParentPath') ?? 'Parent path'}</label>
          <div class="form-fields">
            <input type="text" name="parentPath" autocomplete="off" placeholder="${game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedParentPathHint') ?? 'Optional nested id path'}" />
          </div>
        </div>
      </div>`;

    let outcome = null;
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: {
        title: game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedAddTitle') ?? 'Add nested item',
        icon: 'fa-solid fa-box-archive',
      },
      position: { width: 460 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget?.closest?.('.window-content') ||
              (typeof document !== 'undefined'
                ? document.querySelector(`[data-sh-nested-storage-add-dialog="${dialogUid}"]`)
                : null);
            outcome = {
              uuid: String(root?.querySelector?.('[name="uuid"]')?.value ?? '').trim(),
              quantity: Math.max(1, Math.floor(Number(root?.querySelector?.('[name="quantity"]')?.value ?? 1) || 1)),
              parentPath: this._nestedPathFromText(root?.querySelector?.('[name="parentPath"]')?.value ?? ''),
            };
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });
    if (!outcome?.uuid) return;

    let source = null;
    try {
      source = await fromUuid(outcome.uuid);
    } catch (_) {
      source = null;
    }
    if (!source || source.documentName !== 'Item') {
      ui.notifications?.warn?.(
        game.i18n?.format?.('SPACEHOLDER.ItemWeapon.NestedSourceNotFound', { uuid: outcome.uuid }) ??
        `Item not found: ${outcome.uuid}`
      );
      return;
    }
    if (String(source.uuid ?? '') === String(this.item.uuid ?? '')) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedCannotContainSelf') ??
        'Item cannot contain itself.'
      );
      return;
    }
    const inserted = await addItemToNestedStorage({
      containerItem: this.item,
      item: source,
      quantity: outcome.quantity,
      consumeSource: true,
      parentPath: outcome.parentPath,
    });
    if (!inserted) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedAddFailed') ?? 'Failed to add nested item.'
      );
    }
  }

  async _setNestedStorageSlot(slotKey, pathText) {
    const path = this._nestedPathFromText(pathText);
    if (!path.length) return;
    const itemId = slotKey === 'attached' ? path[0] : path[path.length - 1];
    const storage = normalizeNestedStorage(this.item?.system?.storage);
    const w = this._getWeaponData();
    if (!w.ranged || typeof w.ranged !== 'object') return;
    if (!w.ranged.usage || typeof w.ranged.usage !== 'object') w.ranged.usage = {};

    if (slotKey === 'attached') {
      storage.slots.attachedContainerId = itemId;
      w.ranged.usage.attachedContainerId = itemId;
    } else if (slotKey === 'chamber') {
      storage.slots.chamberItemId = itemId;
      w.ranged.usage.chamberCurrentId = itemId;
    } else {
      return;
    }

    await this.item.update({
      'system.storage': storage,
      'system.weapon': migrateItemWeaponData(w, this.item.system.itemTags),
    });
  }

  async _extractNestedStoragePath(pathText) {
    const path = this._nestedPathFromText(pathText);
    if (!path.length) return;
    const created = await extractNestedItemToActor({ containerItem: this.item, path, quantity: 1 });
    if (!created) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.NestedExtractFailed') ??
        'Failed to extract nested item.'
      );
      return;
    }

    const storage = normalizeNestedStorage(this.item?.system?.storage);
    const removedId = path[path.length - 1];
    let needsPatch = false;
    const w = this._getWeaponData();
    if (storage.slots.attachedContainerId === removedId) {
      storage.slots.attachedContainerId = '';
      if (w.ranged?.usage) w.ranged.usage.attachedContainerId = '';
      needsPatch = true;
    }
    if (storage.slots.chamberItemId === removedId) {
      storage.slots.chamberItemId = '';
      if (w.ranged?.usage) w.ranged.usage.chamberCurrentId = '';
      needsPatch = true;
    }
    if (needsPatch) {
      await this.item.update({
        'system.storage': storage,
        'system.weapon': migrateItemWeaponData(w, this.item.system.itemTags),
      });
    }
  }

  /**
   * @returns {object}
   */
  _getWeaponData() {
    return foundry.utils.duplicate(this.item?.system?.weapon ?? {});
  }

  /**
   * @param {object} nextWeapon
   */
  async _setWeaponData(nextWeapon) {
    const merged = migrateItemWeaponData(nextWeapon, this.item.system.itemTags);
    const patch = { 'system.weapon': merged };
    const pending = this._getPendingNameFromForm();
    if (pending && pending !== String(this.item.name ?? '').trim()) {
      patch.name = pending;
    }
    const pendingQty = this._getPendingQuantityFromForm();
    if (pendingQty !== null) {
      const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
      if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
    }
    await this.item.update(patch);
  }

  /**
   * Кнопки CRUD вариантов атаки (только лист предмета type=item).
   */
  _bindWeaponAttackListeners() {
    const el = this.element;
    if (!el || !this.isEditable) return;

    const bindBtn = (selector, handler) => {
      el.querySelectorAll(selector).forEach((btn) => {
        if (btn.dataset.shWeaponAtkBound === '1') return;
        btn.dataset.shWeaponAtkBound = '1';
        btn.addEventListener('click', handler);
      });
    };

    bindBtn('[data-action="sh-weapon-attack-add"]', async (ev) => {
      ev.preventDefault();
      const channelKey = String(ev.currentTarget?.dataset?.channel ?? '').trim();
      if (!channelKey) return;
      const created = await this._openWeaponAttackDialog({
        title: game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.AddAttack') ?? 'Add attack',
        channelKey,
        action: {
          id: this._newActionId(),
          name: '',
          channel: channelKey,
          mode: 'single',
          origin: 'manual',
          enabled: true,
          isDefault: false,
          description: '',
          modifiers: {},
          overrides: {},
        },
      });
      if (!created) return;
      const w = this._getWeaponData();
      if (!w[channelKey] || typeof w[channelKey] !== 'object') return;
      w[channelKey].attacks = Array.isArray(w[channelKey].attacks) ? w[channelKey].attacks : [];
      w[channelKey].attacks.push(created);
      await this._setWeaponData(w);
      await this.render(false);
    });

    bindBtn('[data-action="sh-weapon-attack-edit"]', async (ev) => {
      ev.preventDefault();
      const channelKey = String(ev.currentTarget?.dataset?.channel ?? '').trim();
      const id = String(ev.currentTarget?.dataset?.attackId ?? '').trim();
      if (!channelKey || !id) return;
      const w = this._getWeaponData();
      const list = w[channelKey]?.attacks;
      const source = Array.isArray(list) ? list.find((a) => String(a?.id ?? '') === id) : null;
      if (!source) return;
      const edited = await this._openWeaponAttackDialog({
        title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.EditAction') ?? 'Edit attack',
        channelKey,
        action: source,
      });
      if (!edited) return;
      const nextList = (Array.isArray(list) ? list : []).map((a) =>
        String(a?.id ?? '') === id ? edited : a
      );
      w[channelKey].attacks = nextList;
      await this._setWeaponData(w);
      await this.render(false);
    });

    bindBtn('[data-action="sh-weapon-attack-duplicate"]', async (ev) => {
      ev.preventDefault();
      const channelKey = String(ev.currentTarget?.dataset?.channel ?? '').trim();
      const id = String(ev.currentTarget?.dataset?.attackId ?? '').trim();
      if (!channelKey || !id) return;
      const w = this._getWeaponData();
      const list = w[channelKey]?.attacks;
      const source = Array.isArray(list) ? list.find((a) => String(a?.id ?? '') === id) : null;
      if (!source) return;
      const duplicateSuffix =
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DuplicateSuffix') ?? 'Copy';
      const cloned = await this._openWeaponAttackDialog({
        title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DuplicateAction') ?? 'Duplicate attack',
        channelKey,
        action: {
          ...foundry.utils.duplicate(source),
          id: this._newActionId(),
          name: source.name ? `${source.name} (${duplicateSuffix})` : '',
          isDefault: false,
          origin: 'manual',
        },
      });
      if (!cloned) return;
      w[channelKey].attacks = [...(Array.isArray(list) ? list : []), cloned];
      await this._setWeaponData(w);
      await this.render(false);
    });

    bindBtn('[data-action="sh-weapon-attack-remove"]', async (ev) => {
      ev.preventDefault();
      const channelKey = String(ev.currentTarget?.dataset?.channel ?? '').trim();
      const id = String(ev.currentTarget?.dataset?.attackId ?? '').trim();
      if (!channelKey || !id) return;
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        classes: ['spaceholder'],
        window: {
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionTitle') ?? 'Delete',
          icon: 'fa-solid fa-trash',
        },
        content: `<p>${foundry.utils.escapeHTML(
          game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionConfirm') ?? 'Delete this attack?'
        )}</p>`,
        yes: {
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Delete') ?? 'Delete',
          icon: 'fa-solid fa-trash',
        },
        no: {
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      });
      if (!confirmed) return;
      const w = this._getWeaponData();
      const list = w[channelKey]?.attacks;
      w[channelKey].attacks = (Array.isArray(list) ? list : []).filter((a) => String(a?.id ?? '') !== id);
      await this._setWeaponData(w);
      await this.render(false);
    });

    const bindDlg = (selector, handler) => {
      el.querySelectorAll(selector).forEach((btn) => {
        if (btn.dataset.shWeaponDlgBound === '1') return;
        btn.dataset.shWeaponDlgBound = '1';
        btn.addEventListener('click', handler);
      });
    };

    const bindGroupBtn = (selector, groupKey) => {
      bindDlg(selector, async (ev) => {
        ev.preventDefault();
        const channelKey = String(ev.currentTarget?.dataset?.channel ?? '').trim();
        if (!channelKey) return;
        await this._openWeaponGroupDialog(channelKey, groupKey);
        await this.render(false);
      });
    };
    bindGroupBtn('[data-action="sh-weapon-edit-features"]', 'features');
    bindGroupBtn('[data-action="sh-weapon-edit-projectile"]', 'projectile');
    bindGroupBtn('[data-action="sh-weapon-edit-usage"]', 'usage');

    bindDlg('[data-action="sh-weapon-edit-channel-options"]', async (ev) => {
      ev.preventDefault();
      const channelKey = String(ev.currentTarget?.dataset?.channel ?? '').trim();
      if (!channelKey) return;
      await this._openWeaponChannelOptionsDialog(channelKey);
      await this.render(false);
    });

    bindDlg('[data-action="sh-ammo-edit-projectile"]', async (ev) => {
      ev.preventDefault();
      await this._openAmmoGroupDialog('projectile');
      await this.render(false);
    });

    bindDlg('[data-action="sh-ammo-edit-resource"]', async (ev) => {
      ev.preventDefault();
      await this._openAmmoGroupDialog('resource');
      await this.render(false);
    });

    bindDlg('[data-action="sh-nested-storage-add"]', async (ev) => {
      ev.preventDefault();
      await this._openNestedStorageAddDialog();
      await this.render(false);
    });

    bindDlg('[data-action="sh-nested-storage-set-attached"]', async (ev) => {
      ev.preventDefault();
      const pathText = String(ev.currentTarget?.dataset?.path ?? '').trim();
      await this._setNestedStorageSlot('attached', pathText);
      await this.render(false);
    });

    bindDlg('[data-action="sh-nested-storage-set-chamber"]', async (ev) => {
      ev.preventDefault();
      const pathText = String(ev.currentTarget?.dataset?.path ?? '').trim();
      await this._setNestedStorageSlot('chamber', pathText);
      await this.render(false);
    });

    bindDlg('[data-action="sh-nested-storage-extract"]', async (ev) => {
      ev.preventDefault();
      const pathText = String(ev.currentTarget?.dataset?.path ?? '').trim();
      await this._extractNestedStoragePath(pathText);
      await this.render(false);
    });
  }

  /**
   * Вкладка «Контейнер»: DnD, создание, извлечение, синхронизация.
   */
  _bindItemContainerListeners() {
    if (!this.item?.system?.itemTags?.isContainer) return;
    const el = this.element;
    if (!el) return;

    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    const readOnly = !this.isEditable;
    const actorMode = !!actor;

    const L = (k) => game.i18n?.localize?.(k) ?? k;

    const zone = el.querySelector('[data-sh-item-container-drop]');
    if (zone && !readOnly && zone.dataset.shContainerZoneBound !== '1') {
      zone.dataset.shContainerZoneBound = '1';
      zone.addEventListener('dragover', (ev) => {
        if (ev.target?.closest?.('.item-container-item-card')) return;
        ev.preventDefault();
        try {
          ev.dataTransfer.dropEffect = 'copy';
        } catch (_) { /* ignore */ }
      });
      zone.addEventListener('drop', async (ev) => {
        if (ev.target?.closest?.('.item-container-item-card')) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (actorMode) await this._onItemContainerExternalDrop(ev);
        else await this._onItemContainerWorldDrop(ev);
      });
    }

    el.querySelectorAll('[data-action="sh-item-container-create"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        const a = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
        if (!a) {
          ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.OnlyOnActor'));
          return;
        }
        const defaultName = L('SPACEHOLDER.Inventory.NewItem');
        const created = await Item.create(
          { name: defaultName, type: 'item', img: Item.DEFAULT_ICON, system: {} },
          { parent: a }
        );
        if (!created) return;
        const ok = await moveActorItemIntoContainer(a, this.item, created.id);
        if (!ok) {
          ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.MoveFailed'));
          try {
            await created.delete();
          } catch (_) { /* ignore */ }
          return;
        }
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-refresh"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        if (actorMode) {
          if (!actor) return;
          const changed = await refreshContainerState(actor, this.item);
          if (changed) ui.notifications?.info?.(L('SPACEHOLDER.ItemContainer.Refreshed'));
        } else {
          const n = await pruneBrokenWorldUuidLinks(this.item);
          if (n) ui.notifications?.info?.(game.i18n.format('SPACEHOLDER.ItemContainer.WorldPruned', { n }));
        }
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-extract"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly || !actor) return;
        const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
        if (!id) return;
        await removeActorItemFromContainer(actor, this.item, id);
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-delete"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly || !actor) return;
        const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
        if (!id) return;
        const child = actor.items.get(id);
        if (!child) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: L('SPACEHOLDER.Inventory.DeleteItem'),
            icon: 'fa-solid fa-trash',
          },
          content: `<p>${foundry.utils.escapeHTML(L('SPACEHOLDER.ItemContainer.DeleteConfirm'))}</p>`,
          yes: { label: L('SPACEHOLDER.Actions.Delete'), icon: 'fa-solid fa-trash' },
          no: { label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        try {
          await child.delete();
        } catch (e) {
          console.error('SpaceHolder | container child delete failed:', e);
          return;
        }
        await this._syncItemContainerContentsAfterDelete(actor, id);
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-unlink"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly || actorMode) return;
        const u = String(ev.currentTarget?.dataset?.worldUuid ?? '').trim();
        if (!u) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: L('SPACEHOLDER.ItemContainer.Unlink'),
            icon: 'fa-solid fa-unlink',
          },
          content: `<p>${foundry.utils.escapeHTML(L('SPACEHOLDER.ItemContainer.UnlinkConfirm'))}</p>`,
          yes: { label: L('SPACEHOLDER.ItemContainer.Unlink'), icon: 'fa-solid fa-unlink' },
          no: { label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        await removeWorldUuidFromContainer(this.item, u);
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-edit"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
        if (!id || !actor) return;
        const doc = actor.items.get(id);
        doc?.sheet?.render(true);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-edit-world"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const u = String(ev.currentTarget?.dataset?.worldUuid ?? '').trim();
        if (!u) return;
        let doc = null;
        try {
          doc = await fromUuid(u);
        } catch (_) {
          doc = null;
        }
        doc?.sheet?.render(true);
      });
    });

    if (!readOnly) {
      el.querySelectorAll('.item-container-item-card').forEach((card) => {
        if (card.dataset.shContainerCardBound === '1') return;
        card.dataset.shContainerCardBound = '1';
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (ev) => this._onItemContainerDragStart(ev));
        card.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          try {
            ev.dataTransfer.dropEffect = 'move';
          } catch (_) { /* ignore */ }
        });
        card.addEventListener('drop', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          await this._onItemContainerReorderDrop(ev);
        });
      });
    }
  }

  /**
   * @param {Actor} actor
   * @param {string} childId
   */
  async _syncItemContainerContentsAfterDelete(actor, childId) {
    const hid = String(this.item?.id ?? '').trim();
    const cid = String(childId ?? '').trim();
    if (!actor || !hid || !cid) return;
    const host = actor.items.get(hid);
    if (!host) return;
    const cur = normalizeItemContainerFields(host.system);
    const nextContents = cur.container.contents.filter(
      (e) => !(e.kind === ENTRY_ACTOR_ITEM && e.itemId === cid),
    );
    await host.update({ 'system.container': { contents: nextContents } }, { render: false });
    rerenderOpenContainerRelatedSheets(actor, [host]);
  }

  /**
   * @param {DragEvent} ev
   */
  _onItemContainerDragStart(ev) {
    const kind = String(ev.currentTarget?.dataset?.entryKind ?? '').trim();
    this._itemContainerDragRef = null;
    if (kind === 'world') {
      const worldUuid = String(ev.currentTarget?.dataset?.worldUuid ?? '').trim();
      if (worldUuid && this.item?.uuid) {
        this._itemContainerDragRef = { kind: 'world', worldUuid };
        const dragData = {
          type: 'Item',
          uuid: worldUuid,
          spaceholder: {
            action: 'worldContainerMove',
            containerHostUuid: this.item.uuid,
            entryUuid: worldUuid,
          },
        };
        try {
          ev.dataTransfer?.setData?.('text/plain', JSON.stringify(dragData));
        } catch (_) { /* ignore */ }
      }
      return;
    }
    const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
    if (id) this._itemContainerDragRef = { kind: 'actor', itemId: id };
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    if (!actor || !id) return;
    const doc = actor.items.get(id);
    if (doc) {
      const dragData = doc.toDragData ? doc.toDragData() : { type: 'Item', uuid: doc.uuid };
      if (!dragData.uuid) dragData.uuid = doc.uuid;
      try {
        ev.dataTransfer?.setData?.('text/plain', JSON.stringify(dragData));
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * @param {DragEvent} ev
   */
  async _onItemContainerReorderDrop(ev) {
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    const dragRef = this._itemContainerDragRef;
    this._itemContainerDragRef = null;
    const card = ev.currentTarget?.closest?.('.item-container-item-card');
    const rowKind = String(card?.dataset?.entryKind ?? dragRef?.kind ?? '').trim();

    if (rowKind === 'world') {
      const dragUuid = String(dragRef?.worldUuid ?? '').trim();
      const targetUuid = String(card?.dataset?.worldUuid ?? '').trim();
      if (!this.isEditable || !dragUuid || !targetUuid || dragUuid === targetUuid) return;
      const list = [...this.element.querySelectorAll('.item-container-item-card[data-entry-kind="world"]')]
        .map((c) => String(c.dataset?.worldUuid ?? '').trim())
        .filter(Boolean);
      const from = list.indexOf(dragUuid);
      const to = list.indexOf(targetUuid);
      if (from < 0 || to < 0) return;
      const next = list.slice();
      const [removed] = next.splice(from, 1);
      next.splice(to, 0, removed);
      await setWorldContainerContentsOrder(this.item, next);
      await this.render(false);
      return;
    }

    const dragId = String(dragRef?.itemId ?? '').trim();
    const targetId = String(card?.dataset?.itemId ?? '').trim();
    if (!this.isEditable || !actor || !dragId || !targetId || dragId === targetId) return;
    const list = [...this.element.querySelectorAll('.item-container-item-card[data-entry-kind="actor"]')]
      .map((c) => String(c.dataset?.itemId ?? '').trim())
      .filter(Boolean);
    const from = list.indexOf(dragId);
    const to = list.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = list.slice();
    const [removed] = next.splice(from, 1);
    next.splice(to, 0, removed);
    await setContainerContentsOrder(actor, this.item, next);
    await this.render(false);
  }

  /**
   * @param {DragEvent} ev
   */
  async _onItemContainerWorldDrop(ev) {
    if (!this.isEditable) return;
    let data = null;
    try {
      const raw = ev.dataTransfer?.getData?.('text/plain') ?? '';
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return;
    }
    if (!data || data.type !== 'Item' || !data.uuid) return;
    let doc = null;
    try {
      doc = await fromUuid(data.uuid);
    } catch (_) {
      doc = null;
    }
    if (!doc || doc.documentName !== 'Item') {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.DropNotAnItem') ?? 'Not an item.');
      return;
    }
    if (doc.uuid === this.item.uuid) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.CycleWarning') ?? 'Cannot nest that way.');
      return;
    }
    const parentActor = doc.parent?.documentName === 'Actor' ? doc.parent : null;
    if (parentActor) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ItemContainer.DropEmbeddedNotAllowed') ??
          'Drop a sidebar/compendium item, not an item on a character.',
      );
      return;
    }
    const ok = await addWorldUuidToContainer(this.item, doc.uuid);
    if (!ok) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.MoveFailed') ?? 'Could not add link.');
      return;
    }
    await this.render(false);
  }

  /**
   * @param {DragEvent} ev
   */
  async _onItemContainerExternalDrop(ev) {
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    if (!this.isEditable || !actor) return;
    let data = null;
    try {
      const raw = ev.dataTransfer?.getData?.('text/plain') ?? '';
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return;
    }
    if (!data || data.type !== 'Item' || !data.uuid) return;
    let doc = null;
    try {
      doc = await fromUuid(data.uuid);
    } catch (_) {
      doc = null;
    }
    if (!doc || doc.documentName !== 'Item') {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.DropNotAnItem') ?? 'Not an item.');
      return;
    }
    if (doc.parent?.id !== actor.id) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.DropWrongActor') ?? 'Item must belong to the same actor.');
      return;
    }
    if (doc.id === this.item.id) return;
    if (wouldCreateItemContainerCycle(actor, doc.id, this.item.id)) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.CycleWarning') ?? 'Cannot nest that way.');
      return;
    }
    const ok = await moveActorItemIntoContainer(actor, this.item, doc.id);
    if (!ok) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.MoveFailed') ?? 'Could not place item.');
      return;
    }
    await this.render(false);
  }

  /**
   * Привести поля weapon после FormData (теги textarea, пустые id).
   * Частичный submit мержим с документом, чтобы не потерять соседние ветки `weapon.*`.
   * @param {object} [data]
   */
  _postProcessWeaponSubmitData(data) {
    if (!data || typeof data !== 'object') return;
    if (!data.system || typeof data.system !== 'object') return;
    if (!Object.prototype.hasOwnProperty.call(data.system, 'weapon')) return;

    const incoming = data.system.weapon;
    if (!incoming || typeof incoming !== 'object') return;

    const docW =
      this.item?.system?.weapon && typeof this.item.system.weapon === 'object'
        ? foundry.utils.duplicate(this.item.system.weapon)
        : {};
    const merged = foundry.utils.mergeObject(docW, incoming, { inplace: false, recursive: true });

    for (const key of ['melee', 'ranged', 'thrown']) {
      const ch = merged[key];
      if (!ch || typeof ch !== 'object') continue;
      if (ch.defaultAttackId === '' || ch.defaultAttackId === undefined) {
        ch.defaultAttackId = null;
      } else if (typeof ch.defaultAttackId === 'string') {
        const t = ch.defaultAttackId.trim();
        ch.defaultAttackId = t.length ? t : null;
      }
    }

    data.system.weapon = migrateItemWeaponData(merged, this.item.system.itemTags);
  }

  /**
   * Поля без привязки к FormData (теги — `data-sh-item-tag`; анатомия/покрытие — диалог и PIXI-редактор):
   * при submitOnChange вложенный `system` приходит без них → DataModel подставляет дефолты и затирает данные.
   * Подмешиваем снимок с документа, как для `itemTags`.
   * @param {object} [data]
   */
  _preserveWearableGearSubmitFields(data) {
    if (!data || typeof data !== 'object') return;

    const hasNestedSystem =
      data.system && typeof data.system === 'object' && !Array.isArray(data.system);
    const hasFlatSystem = Object.keys(data).some(
      (k) => typeof k === 'string' && k.startsWith('system.')
    );
    if (!hasNestedSystem && !hasFlatSystem) return;

    const itemSys = this.item?.system ?? {};
    const src = itemSys.itemTags;
    const tagSnap = {
      isArmor: !!(src && src.isArmor),
      isActions: !!(src && src.isActions),
      isModifiers: !!(src && src.isModifiers),
      isMelee: !!(src && src.isMelee),
      isRanged: !!(src && src.isRanged),
      isThrown: !!(src && src.isThrown),
      isAmmo: !!(src && src.isAmmo),
      isContainer: !!(src && src.isContainer),
    };

    const icPreserve = normalizeItemContainerFields(itemSys);

    const anatomyId = itemSys.anatomyId ?? null;
    const coveredParts = Array.isArray(itemSys.coveredParts)
      ? foundry.utils.duplicate(itemSys.coveredParts)
      : [];

    const weaponSnap =
      itemSys.weapon && typeof itemSys.weapon === 'object'
        ? foundry.utils.duplicate(itemSys.weapon)
        : null;
    const storageSnap = normalizeNestedStorage(itemSys.storage);

    if (hasNestedSystem) {
      data.system.itemTags = { ...tagSnap };
      data.system.anatomyId = anatomyId;
      data.system.coveredParts = coveredParts;
      data.system.storage = storageSnap;
      data.system.containerHostId = icPreserve.containerHostId;
      data.system.container = foundry.utils.duplicate(icPreserve.container);
      if (weaponSnap && !Object.prototype.hasOwnProperty.call(data.system, 'weapon')) {
        data.system.weapon = weaponSnap;
      }
    }
    data['system.itemTags'] = { ...tagSnap };
    data['system.anatomyId'] = anatomyId;
    data['system.coveredParts'] = coveredParts;
    data['system.storage'] = storageSnap;
    data['system.containerHostId'] = icPreserve.containerHostId;
    data['system.container'] = foundry.utils.duplicate(icPreserve.container);
  }

  /**
   * @inheritDoc
   */
  async _prepareSubmitData(event, form, formData) {
    const data = await super._prepareSubmitData(event, form, formData);
    this._preserveWearableGearSubmitFields(data);
    this._postProcessWeaponSubmitData(data);
    return data;
  }

  /**
   * Теги правятся локально; одна кнопка «Применить» пишет `system.itemTags` и перерисовывает вкладки.
   * @inheritDoc
   */
  async _onRender(context, options) {
    await super._onRender(context, options);

    this._bindWeaponAttackListeners();
    this._bindItemContainerListeners();

    if (!this.isEditable) return;

    // Tag checkboxes have no `name` and are committed only by the "Apply" button.
    // In v14, letting their `change` event reach the form (submitOnChange) produces an
    // empty diff which then crashes Foundry's `cleanData` on a near-empty change object.
    // Stop the change/input/click events so the form does not auto-submit on toggle.
    const tagCheckboxes = this.element?.querySelectorAll?.('input[type="checkbox"][data-sh-item-tag]') ?? [];
    for (const cb of tagCheckboxes) {
      if (cb.dataset.spaceholderTagBound === '1') continue;
      cb.dataset.spaceholderTagBound = '1';
      const swallow = (ev) => {
        ev.stopImmediatePropagation();
      };
      cb.addEventListener('change', swallow);
      cb.addEventListener('input', swallow);
    }

    const btn = this.element?.querySelector?.('[data-action="sh-item-tags-apply"]');
    if (btn && !btn.dataset.spaceholderTagsApplyBound) {
      btn.dataset.spaceholderTagsApplyBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const root = this.element;
        const readTag = (key) => {
          const input = root.querySelector(`input[type="checkbox"][data-sh-item-tag="${key}"]`);
          return !!input?.checked;
        };
        const itemTags = {
          isArmor: readTag('isArmor'),
          isActions: readTag('isActions'),
          isModifiers: readTag('isModifiers'),
          isMelee: readTag('isMelee'),
          isRanged: readTag('isRanged'),
          isThrown: readTag('isThrown'),
          isAmmo: readTag('isAmmo'),
          isContainer: readTag('isContainer'),
        };
        const patch = { 'system.itemTags': itemTags };
        const pending = this._getPendingNameFromForm();
        if (pending && pending !== String(this.item.name ?? '').trim()) {
          patch.name = pending;
        }
        const pendingQty = this._getPendingQuantityFromForm();
        if (pendingQty !== null) {
          const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
          if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
        }
        this._wearableApplyingItemTags = true;
        try {
          await this.item.update(patch);
        } catch (e) {
          console.error('SpaceHolder | itemTags apply failed:', e);
          return;
        } finally {
          this._wearableApplyingItemTags = false;
        }
        this._activeTabPrimary = 'tags';
        await this.render(false);
      });
    }
  }

}

/**
 * Submit формы (submitOnChange) иногда присылает вложенный `change.system` с `itemTags: все false`, хотя в документе
 * теги включены; чекбоксы тегов не в FormData. Пока лист выставляет `_wearableApplyingItemTags` (кнопка «Применить» тегов),
 * восстановление не делаем — иначе сброс тегов через «Применить» откатывается.
 * @param {Item} item
 * @param {object} change
 * @returns {boolean}
 */
function fixSpuriousWearableItemTagsWipe(item, change) {
  if (item?.type !== 'item' || !change) return false;
  if (item.sheet?._wearableApplyingItemTags) return false;
  const cur = item.system?.itemTags;
  const curAny = cur && (
    cur.isArmor ||
    cur.isActions ||
    cur.isModifiers ||
    cur.isMelee ||
    cur.isRanged ||
    cur.isThrown ||
    cur.isAmmo ||
    cur.isContainer
  );
  if (!curAny) return false;

  if (change.system && typeof change.system === 'object' && !Array.isArray(change.system)) {
    const inc = change.system.itemTags;
    if (!inc || typeof inc !== 'object') return false;
    const incAllFalse =
      !inc.isArmor &&
      !inc.isActions &&
      !inc.isModifiers &&
      !inc.isMelee &&
      !inc.isRanged &&
      !inc.isThrown &&
      !inc.isAmmo &&
      !inc.isContainer;
    if (!incAllFalse) return false;
    const sysKeys = Object.keys(change.system);
    const onlyItemTags = sysKeys.length === 1 && sysKeys[0] === 'itemTags';
    if (onlyItemTags) return false;
    change.system.itemTags = foundry.utils.duplicate(cur);
    return true;
  }

  const flatIt = change['system.itemTags'];
  if (flatIt && typeof flatIt === 'object') {
    const incAllFalse =
      !flatIt.isArmor &&
      !flatIt.isActions &&
      !flatIt.isModifiers &&
      !flatIt.isMelee &&
      !flatIt.isRanged &&
      !flatIt.isThrown &&
      !flatIt.isAmmo &&
      !flatIt.isContainer;
    if (!incAllFalse) return false;
    const flatSys = Object.keys(change).filter(
      (k) => typeof k === 'string' && k.startsWith('system.') && k !== 'system.itemTags'
    );
    if (flatSys.length === 0) return false;
    change['system.itemTags'] = foundry.utils.duplicate(cur);
    return true;
  }

  return false;
}

/**
 * Те же «полные» diff по system, что и для тегов: в форме нет anatomyId/coveredParts, в change приходит null/[].
 * Явные апдейты только из диалога/редактора покрытия не трогаем.
 * @param {Item} item
 * @param {object} change
 * @returns {boolean}
 */
function fixSpuriousWearableCoverageWipe(item, change) {
  if (item?.type !== 'item' || !change) return false;

  const doc = item.system ?? {};
  const docAidRaw = doc.anatomyId;
  const docAidStr = docAidRaw != null ? String(docAidRaw).trim() : '';
  const docHasAnatomy = docAidStr.length > 0;
  const docParts = Array.isArray(doc.coveredParts) ? doc.coveredParts : [];
  const docHasParts = docParts.length > 0;
  if (!docHasAnatomy && !docHasParts) return false;

  const isCoverageOnlyKeys = (keys) => {
    if (!keys.length) return false;
    const allowed = new Set(['anatomyId', 'coveredParts']);
    return keys.every((k) => allowed.has(k));
  };

  let fixed = false;

  if (change.system && typeof change.system === 'object' && !Array.isArray(change.system)) {
    const inc = change.system;
    const keys = Object.keys(inc);
    if (keys.length === 0) return false;
    if (keys.length <= 3 && isCoverageOnlyKeys(keys)) return false;

    const incAidRaw = inc.anatomyId;
    const incAidStr = incAidRaw != null ? String(incAidRaw).trim() : '';
    const wipesAnatomy = Object.prototype.hasOwnProperty.call(inc, 'anatomyId') && !incAidStr;
    const incCp = inc.coveredParts;
    const wipesParts =
      Object.prototype.hasOwnProperty.call(inc, 'coveredParts') &&
      Array.isArray(incCp) &&
      incCp.length === 0 &&
      docHasParts;

    if (wipesAnatomy && docHasAnatomy) {
      change.system.anatomyId = docAidRaw;
      fixed = true;
    }
    if (wipesParts && docHasParts) {
      change.system.coveredParts = foundry.utils.duplicate(docParts);
      fixed = true;
    }
    return fixed;
  }

  const flatSys = Object.keys(change).filter((k) => typeof k === 'string' && k.startsWith('system.'));
  if (!flatSys.length) return false;
  const coverageFlat = new Set(['system.anatomyId', 'system.coveredParts']);
  const nonCoverageFlat = flatSys.filter((k) => !coverageFlat.has(k));
  if (nonCoverageFlat.length === 0) return false;

  const flatAid = change['system.anatomyId'];
  const wipesFlatAnatomy =
    Object.prototype.hasOwnProperty.call(change, 'system.anatomyId') &&
    (flatAid == null || String(flatAid).trim() === '');
  const flatCp = change['system.coveredParts'];
  const wipesFlatParts =
    Object.prototype.hasOwnProperty.call(change, 'system.coveredParts') &&
    Array.isArray(flatCp) &&
    flatCp.length === 0 &&
    docHasParts;

  if (wipesFlatAnatomy && docHasAnatomy) {
    change['system.anatomyId'] = docAidRaw;
    fixed = true;
  }
  if (wipesFlatParts && docHasParts) {
    change['system.coveredParts'] = foundry.utils.duplicate(docParts);
    fixed = true;
  }
  return fixed;
}

if (!globalThis.__spaceholderWearableItemPreUpdate) {
  globalThis.__spaceholderWearableItemPreUpdate = true;
  Hooks.on('preUpdateItem', (item, change, _options, _userId) => {
    if (item?.type !== 'item') return;
    fixSpuriousWearableItemTagsWipe(item, change);
    fixSpuriousWearableCoverageWipe(item, change);
  });
}
