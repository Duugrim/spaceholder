import {
  calculateStopThickness,
  calculateThicknessCheck,
  chooseDefaultMaterialId,
  collectArmorSources,
  collectMaterialChoices,
  collectProjectileSources,
  damageTypeOptions,
  listArmorCoveredSlotRefs,
  minimalAnatomyForArmorSlot,
  previewArmorTraversal,
} from './armor-penetration-tester.mjs';

let _singleton = null;

const TAB_PROJECTILES = 'projectiles';
const TAB_ARMOR = 'armor';

const SORT_OPTIONS = Object.freeze([
  { id: 'name', labelKey: 'SPACEHOLDER.ArmorTester.Sort.Name' },
  { id: 'damage', labelKey: 'SPACEHOLDER.ArmorTester.Sort.Damage' },
  { id: 'armorPen', labelKey: 'SPACEHOLDER.ArmorTester.Sort.ArmorPen' },
  { id: 'hardness', labelKey: 'SPACEHOLDER.ArmorTester.Sort.Hardness' },
  { id: 'energy', labelKey: 'SPACEHOLDER.ArmorTester.Sort.Energy' },
  { id: 'stopThickness', labelKey: 'SPACEHOLDER.ArmorTester.Sort.StopThickness' },
]);

const MODE_OPTIONS = Object.freeze([
  { id: 'stop', labelKey: 'SPACEHOLDER.ArmorTester.Modes.Stop' },
  { id: 'check', labelKey: 'SPACEHOLDER.ArmorTester.Modes.Check' },
]);

const SOURCE_FILTER_OPTIONS = Object.freeze([
  { id: 'all', labelKey: 'SPACEHOLDER.ArmorTester.Filters.AllSources' },
  { id: 'compendium', labelKey: 'SPACEHOLDER.ArmorTester.Filters.CompendiumOnly' },
  { id: 'world', labelKey: 'SPACEHOLDER.ArmorTester.Filters.WorldOnly' },
]);

const DIRECTION_OPTIONS = Object.freeze(['front', 'back', 'left', 'right', 'top', 'bottom']);

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

function fmt(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '∞';
  const factor = 10 ** digits;
  return String(Math.round(n * factor) / factor);
}

function clean(value) {
  return String(value ?? '').trim();
}

function optionList(options, selectedId) {
  return options.map((opt) => ({
    ...opt,
    label: opt.label ?? L(opt.labelKey, opt.id),
    selected: String(opt.id) === String(selectedId),
  }));
}

function sourceLabel(sourceKind) {
  return sourceKind === 'pack'
    ? L('SPACEHOLDER.ArmorTester.Source.Pack', 'Pack')
    : L('SPACEHOLDER.ArmorTester.Source.World', 'World');
}

function primaryStat(source, field, fallback = 0) {
  const value = Number(source?.primary?.[field] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function hasDamageType(source, damageType) {
  if (!damageType) return true;
  return Array.isArray(source?.damageTypes) && source.damageTypes.includes(damageType);
}

function bodyPartLabel(slotRef, part) {
  const typeId = clean(part?.id ?? slotRef);
  const key = `SPACEHOLDER.BodyParts.${typeId}`;
  const localized = L(key, '');
  return localized || clean(part?.displayName ?? part?.name) || slotRef;
}

export function openArmorPenetrationTesterApp() {
  if (!game.user?.isGM) {
    ui.notifications?.warn?.(L('SPACEHOLDER.ArmorTester.Messages.GmOnly', 'Only the GM can open the armor tester.'));
    return null;
  }

  if (_singleton) {
    _singleton.render(true);
    _singleton.bringToFront?.();
    return _singleton;
  }

  _singleton = new ArmorPenetrationTesterApp();
  _singleton.render(true);
  return _singleton;
}

export class ArmorPenetrationTesterApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-armor-penetration-tester',
    classes: ['spaceholder', 'armor-penetration-tester'],
    tag: 'div',
    window: { title: 'Armor Penetration Tester', resizable: true },
    position: { width: 1040, height: 760 },
  };

  static PARTS = {
    main: { root: true, template: 'systems/spaceholder/templates/damage/armor-penetration-tester-app.hbs' },
  };

  constructor() {
    super();
    this._activeTab = TAB_PROJECTILES;
    this._loaded = false;
    this._loading = false;
    this._materials = [];
    this._projectiles = [];
    this._armors = [];
    this._state = {
      search: '',
      damageType: '',
      sourceFilter: 'all',
      sort: 'name',
      mode: 'stop',
      materialId: '',
      checkThickness: 10,
      selectedProjectileId: '',
      selectedArmorId: '',
      selectedSlotRef: '',
      hitDirection: 'front',
    };
  }

  async close(options = {}) {
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  async refreshData() {
    this._loaded = false;
    await this._ensureDataLoaded();
    this.render(false);
  }

  async _ensureDataLoaded() {
    if (this._loaded || this._loading) return;
    this._loading = true;
    try {
      this._materials = collectMaterialChoices();
      const sourceOpts = { sourceFilter: this._state.sourceFilter || 'all' };
      this._projectiles = await collectProjectileSources(sourceOpts);
      this._armors = await collectArmorSources(sourceOpts);
      if (!this._state.materialId) this._state.materialId = chooseDefaultMaterialId(this._materials);
      const pids = new Set((this._projectiles ?? []).map((p) => p.id));
      if (!pids.has(this._state.selectedProjectileId)) {
        this._state.selectedProjectileId = this._projectiles[0]?.id ?? '';
      }
      const aids = new Set((this._armors ?? []).map((a) => a.id));
      if (!aids.has(this._state.selectedArmorId)) {
        this._state.selectedArmorId = this._armors[0]?.id ?? '';
        this._state.selectedSlotRef = '';
      }
      this._loaded = true;
    } finally {
      this._loading = false;
    }
  }

  _selectedMaterial() {
    const id = clean(this._state.materialId) || chooseDefaultMaterialId(this._materials);
    return this._materials.find((m) => m.id === id) ?? this._materials[0] ?? null;
  }

  _selectedProjectile() {
    return this._projectiles.find((p) => p.id === this._state.selectedProjectileId) ?? this._projectiles[0] ?? null;
  }

  _selectedArmor() {
    return this._armors.find((a) => a.id === this._state.selectedArmorId) ?? this._armors[0] ?? null;
  }

  _projectileRows() {
    const material = this._selectedMaterial()?.data ?? null;
    const search = this._state.search.toLowerCase();
    const damageType = this._state.damageType;
    const mode = this._state.mode;
    const thickness = Number(this._state.checkThickness) || 0;

    let rows = this._projectiles
      .filter((src) => !search || `${src.name} ${src.caliberTag} ${src.compatibilityTags.join(' ')}`.toLowerCase().includes(search))
      .filter((src) => hasDamageType(src, damageType))
      .map((src) => {
        const stop = material ? calculateStopThickness(src.applications, material) : null;
        const check = material ? calculateThicknessCheck(src.applications, material, thickness) : null;
        const result = mode === 'check'
          ? (check?.penetrates ? L('SPACEHOLDER.ArmorTester.Results.Penetrates', 'Penetrates') : L('SPACEHOLDER.ArmorTester.Results.Stopped', 'Stopped'))
          : `${fmt(stop?.thickness ?? 0)} ${L('SPACEHOLDER.ArmorTester.Units.Mm', 'mm')}`;
        const showCheckResidual = mode === 'check' && !!check?.penetrates;
        const sumResidual = (check?.rows ?? []).reduce((sum, row) => sum + (Number(row.residualDamage) || 0), 0);
        return {
          ...src,
          selected: src.id === this._state.selectedProjectileId,
          sourceLabel: sourceLabel(src.sourceKind),
          damageText: src.damageTypes.join(', '),
          damage: fmt(src.totalDamage),
          armorPen: fmt(primaryStat(src, 'armorPen')),
          hardness: fmt(primaryStat(src, 'hardness', 1)),
          energy: fmt(src.maxEnergy),
          stopThickness: stop?.thickness ?? 0,
          stopThicknessText: fmt(stop?.thickness ?? 0),
          showCheckResidual,
          residualDamageText: fmt(sumResidual),
          result,
          resultClass: mode === 'check' ? (check?.penetrates ? 'is-penetrates' : 'is-stopped') : '',
        };
      });

    const sort = this._state.sort;
    rows = rows.sort((a, b) => {
      if (sort === 'damage') return Number(b.totalDamage) - Number(a.totalDamage);
      if (sort === 'armorPen') return primaryStat(b, 'armorPen') - primaryStat(a, 'armorPen');
      if (sort === 'hardness') return primaryStat(b, 'hardness', 1) - primaryStat(a, 'hardness', 1);
      if (sort === 'energy') return Number(b.maxEnergy) - Number(a.maxEnergy);
      if (sort === 'stopThickness') return Number(a.stopThickness) - Number(b.stopThickness);
      return clean(a.name).localeCompare(clean(b.name), game?.i18n?.lang || 'en');
    });
    return rows;
  }

  _previewContext() {
    const projectile = this._selectedProjectile();
    const armor = this._selectedArmor();
    const slotRefs = listArmorCoveredSlotRefs(armor);
    const bodyPartChoices = slotRefs.map((slotRef) => {
      const part = { id: slotRef, name: slotRef };
      return {
        id: slotRef,
        name: bodyPartLabel(slotRef, part),
        selected: false,
      };
    });

    if (!bodyPartChoices.some((p) => p.id === this._state.selectedSlotRef)) {
      this._state.selectedSlotRef = bodyPartChoices[0]?.id ?? '';
    }
    for (const choice of bodyPartChoices) {
      choice.selected = choice.id === this._state.selectedSlotRef;
    }

    const anatomy = this._state.selectedSlotRef ? minimalAnatomyForArmorSlot(this._state.selectedSlotRef) : null;
    const bodyParts = anatomy?.bodyParts ?? {};

    let traversal = null;
    if (projectile && armor && anatomy && this._state.selectedSlotRef) {
      traversal = previewArmorTraversal({
        projectile,
        armor,
        anatomy,
        slotRef: this._state.selectedSlotRef,
        hitDirection: this._state.hitDirection,
        resolveMaterial: (id) => game.spaceholder.materialsManager.getMaterial(id),
      });
    }

    const bodyDamageRows = Object.entries(traversal?.bodyDamageBySlot ?? {}).flatMap(([slotRef, hits]) => {
      const part = bodyParts[slotRef];
      return (hits ?? []).map((hit) => ({
        slotRef,
        partName: bodyPartLabel(slotRef, part),
        type: hit.type,
        amount: fmt(hit.amount),
      }));
    });

    const traceRows = (traversal?.trace ?? []).map((entry, idx) => ({
      idx: idx + 1,
      kind: entry.kind,
      phase: entry.phase ?? '',
      slotRef: entry.slotRef ?? '',
      material: entry.material ?? '',
      type: entry.type ?? entry.fromType ?? '',
      amount: fmt(entry.amount ?? entry.remaining ?? 0),
      eAR: entry.eAR != null ? fmt(entry.eAR) : '',
      residual: entry.residual != null ? fmt(entry.residual) : '',
    }));

    return {
      projectile,
      armor,
      coverageNote: L('SPACEHOLDER.ArmorTester.Preview.CoverageNote', 'Body location is taken from this item’s covered areas (no anatomy preset).'),
      noArmorCoverage: Boolean(armor) && slotRefs.length === 0,
      bodyPartChoices,
      bodyDamageRows,
      traceRows,
      pathRows: traversal?.path ?? [],
      hasPreview: !!traversal,
      previewEmpty: !!(projectile && armor && anatomy && this._state.selectedSlotRef && !bodyDamageRows.length),
    };
  }

  async _prepareContext() {
    const isGM = !!game.user?.isGM;
    await this._ensureDataLoaded();
    const selectedMaterial = this._selectedMaterial();
    const preview = this._previewContext();

    return {
      isGM,
      loading: this._loading,
      activeTab: this._activeTab,
      tabProjectiles: this._activeTab === TAB_PROJECTILES,
      tabArmor: this._activeTab === TAB_ARMOR,
      state: this._state,
      materials: this._materials.map((m) => ({ ...m, selected: m.id === this._state.materialId })),
      materialName: selectedMaterial?.label ?? '—',
      modeOptions: optionList(MODE_OPTIONS, this._state.mode),
      sortOptions: optionList(SORT_OPTIONS, this._state.sort),
      sourceFilterOptions: optionList(SOURCE_FILTER_OPTIONS, this._state.sourceFilter),
      damageTypeOptions: [{ id: '', label: L('SPACEHOLDER.ArmorTester.Filters.AllTypes', 'All types'), selected: !this._state.damageType }]
        .concat(damageTypeOptions().map((o) => ({ ...o, selected: o.id === this._state.damageType }))),
      projectiles: this._projectileRows(),
      projectileChoices: this._projectiles.map((projectile) => ({
        id: projectile.id,
        name: projectile.name,
        selected: projectile.id === this._state.selectedProjectileId,
      })),
      projectileCount: this._projectiles.length,
      armors: this._armors.map((armor) => ({
        ...armor,
        selected: armor.id === this._state.selectedArmorId,
        sourceLabel: sourceLabel(armor.sourceKind),
      })),
      directionOptions: DIRECTION_OPTIONS.map((id) => ({
        id,
        label: L(`SPACEHOLDER.ArmorTester.Directions.${id}`, id),
        selected: id === this._state.hitDirection,
      })),
      ...preview,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    if (!el) return;

    const rerender = () => {
      try { this.render(false); } catch (_) { /* ignore */ }
    };

    el.querySelectorAll('[data-action="set-tab"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const tab = clean(btn.dataset.tab);
        if ([TAB_PROJECTILES, TAB_ARMOR].includes(tab)) {
          this._activeTab = tab;
          rerender();
        }
      });
    });

    el.querySelectorAll('[data-action="refresh-data"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        this.refreshData();
      });
    });

    el.querySelectorAll('[data-state-field]').forEach((input) => {
      input.addEventListener('change', () => {
        const field = clean(input.dataset.stateField);
        if (!field || !(field in this._state)) return;
        if (field === 'sourceFilter') this._loaded = false;
        this._state[field] = input.type === 'number' ? Number(input.value) || 0 : clean(input.value);
        rerender();
      });
    });

    el.querySelectorAll('[data-action="select-projectile"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        this._state.selectedProjectileId = clean(btn.dataset.projectileId);
        rerender();
      });
    });

    el.querySelectorAll('[data-action="select-armor"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        this._state.selectedArmorId = clean(btn.dataset.armorId);
        this._state.selectedSlotRef = '';
        rerender();
      });
    });
  }
}
