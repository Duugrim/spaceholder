import { anatomyManager, resolveBodyPartDisplayName } from '../anatomy-manager.mjs';
import { getMaxApFromAbilities } from '../helpers/actions/transaction-ledger.mjs';
import { resolveCoverageEntryToActorSlots } from '../helpers/body-part-coverage.mjs';
import { ensureActorPartRelationsSynced } from '../helpers/anatomy-relations.mjs';
import { normalizeApplications } from '../helpers/damage/damage-resolver.mjs';
import { resolveBodyTraversal } from '../helpers/damage/body-traversal-resolver.mjs';
import { ensureActorPartBodyLayersSynced } from '../helpers/damage/body-layers-defaults.mjs';
import { materialsManager, ensureLayerDefaults } from '../helpers/damage/materials-manager.mjs';
import { describeInjury } from '../helpers/damage/injury-description.mjs';
import { buildProjectileApplications, composeProjectileApplications } from './item.mjs';

function _sanitizeAimingArcSystemData(systemData) {
  if (!systemData || typeof systemData !== 'object') return;
  const cfg = CONFIG?.SPACEHOLDER?.aimingArc ?? {};
  const standardZoneCount = Math.max(1, Number(cfg.standardZoneCount) || 4);
  const defaults = Array.isArray(cfg.defaultZoneWeights) ? cfg.defaultZoneWeights : [5, 15, 25, 30];
  const defaultPurpleZoneDeg = Math.max(0, Number(cfg.defaultPurpleZoneDeg) || 1);
  const defaultTotalArcDeg = Math.max(0, Number(cfg.defaultTotalArcDeg) || 90);
  const defaultDeadZoneDeg = Math.max(0, Number(cfg.defaultDeadZoneDeg) || 0);
  const defaultBaseDev = Math.max(0, Number(cfg.defaultDeviationBaseDeg) || 1);

  const aimingArc = (systemData.aimingArc && typeof systemData.aimingArc === 'object') ? systemData.aimingArc : {};
  const legacyZones = Array.isArray(aimingArc.zoneHalfDegrees) ? aimingArc.zoneHalfDegrees : [];
  const rawWeights = Array.isArray(aimingArc.zoneWeights) ? aimingArc.zoneWeights : [];
  const zoneWeights = [];
  const weightOffset = rawWeights.length >= standardZoneCount + 1 ? 1 : 0;
  for (let i = 0; i < standardZoneCount; i += 1) {
    const fallback = Number(defaults[i] ?? 0);
    const hasNewValue = Number.isFinite(Number(rawWeights[i + weightOffset]));
    const hasLegacyValue = Number.isFinite(Number(legacyZones[i + 1]));
    const sourceValue = hasNewValue ? Number(rawWeights[i + weightOffset]) : (hasLegacyValue ? Number(legacyZones[i + 1]) : fallback);
    const safe = Number.isFinite(sourceValue) ? Math.max(0, sourceValue) : 0;
    zoneWeights.push(safe);
  }

  const purpleRaw = Number(aimingArc.purpleZoneDeg);
  const legacyPurple = Number(legacyZones[0]);
  const purpleZoneDeg = Number.isFinite(purpleRaw)
    ? Math.max(0, purpleRaw)
    : (Number.isFinite(legacyPurple) ? Math.max(0, legacyPurple) : defaultPurpleZoneDeg);

  const totalArcRaw = Number(aimingArc.totalArcDeg);
  const legacyTotalArc = legacyZones.slice(1).reduce((sum, val) => sum + Math.max(0, Number(val) || 0), 0);
  const totalArcDeg = Number.isFinite(totalArcRaw)
    ? Math.max(0, totalArcRaw)
    : (legacyTotalArc > 0 ? legacyTotalArc : defaultTotalArcDeg);

  const deadRaw = Number(aimingArc.deadZoneDeg);
  const deadZoneDeg = Number.isFinite(deadRaw) ? Math.max(0, deadRaw) : defaultDeadZoneDeg;
  const baseDev = Number(aimingArc.deviationBaseDeg);
  aimingArc.purpleZoneDeg = purpleZoneDeg;
  aimingArc.totalArcDeg = totalArcDeg;
  aimingArc.zoneWeights = zoneWeights;
  aimingArc.deadZoneDeg = deadZoneDeg;
  aimingArc.deviationBaseDeg = Number.isFinite(baseDev) ? Math.max(0, baseDev) : defaultBaseDev;
  systemData.aimingArc = aimingArc;
}

/**
 * Extend the base Actor document by defining a custom roll data structure which is ideal for the Simple system.
 * @extends {Actor}
 */
export class SpaceHolderActor extends Actor {
  /** @override */
  prepareBaseData() {
    // CRITICAL: must invoke super to run Foundry v14's `_clearData`, which
    // initializes `this.overrides`, `this.tokenActiveEffectChanges`,
    // `this.statuses`, and clears `this._completedActiveEffectPhases`.
    // Without it, `applyActiveEffects` throws either
    //   "ActiveEffect application phase ... has already completed"
    // or "One of original or other are not Objects!" (when `this.overrides`
    // is undefined for synthetic/token actors).
    super.prepareBaseData();
  }

  /**
   * @override
   * Augment the actor source data with additional dynamic data. Typically,
   * you'll want to handle most of your calculated/derived data in this step.
   * Data calculated in this step should generally not exist in template.json
   * (such as ability modifiers rather than ability scores) and should be
   * available both inside and outside of character sheets (such as if an actor
   * is queried and has a roll executed directly from it).
   */
  prepareDerivedData() {
    const actorData = this;

    // Make separate methods for each Actor type (character, npc, etc.) to keep
    // things organized.
    this._prepareCharacterData(actorData);
    this._prepareNpcData(actorData);
  }

  /**
   * D20-style ability modifiers; shared by types that define `system.abilities` (incl. NPC/loot for v14 effects/initiative).
   * @param {object} systemData
   */
  _prepareAbilityModifiers(systemData) {
    if (!systemData?.abilities || typeof systemData.abilities !== 'object') return;
    for (const ability of Object.values(systemData.abilities)) {
      if (ability && typeof ability === 'object' && Number.isFinite(Number(ability.value))) {
        ability.mod = Math.floor((Number(ability.value) - 10) / 2);
      }
    }
  }

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(actorData) {
    if (actorData.type !== 'character') return;

    const systemData = actorData.system;

    // Применяем модификаторы от экипированных надетых предметов к базовым значениям
    this._applyWearableModifiers(systemData);

    this._prepareAbilityModifiers(systemData);

    this._prepareDerivedCharacterStats(systemData);
    _sanitizeAimingArcSystemData(systemData);

    // Process body parts health system (always based on health)
    this._prepareBodyParts(systemData);
  }

  /**
   * MVP производные величины с листа персонажа (формулы можно заменить позже).
   * Пишет в `systemData.derivedStats` только в рантайме (не в template.json).
   * @param {object} systemData
   */
  _prepareDerivedCharacterStats(systemData) {
    const abs = systemData.abilities || {};
    const val = (k) => {
      const n = Number(abs[k]?.value);
      return Number.isFinite(n) ? n : 0;
    };
    const mod = (k) => {
      const n = Number(abs[k]?.mod);
      return Number.isFinite(n) ? n : 0;
    };

    const endM = mod('end');
    const strM = mod('str');
    const strV = val('str');
    const dexM = mod('dex');
    const dexV = val('dex');
    const corM = mod('cor');
    const perM = mod('per');
    const intM = mod('int');
    const intV = val('int');
    const lucM = mod('luc');

    // Прыжки (м): грубая линейная связь от STR+DEX
    const jumpHigh = Math.max(0, 0.25 + (strV + dexV - 20) * 0.04);
    const jumpLong = Math.max(0, 1.8 + (strV + dexV - 20) * 0.15);

    const apSlice = Math.max(1, Number(CONFIG.SPACEHOLDER?.movementApTimeSlice) || 10);
    const minDistPerSlice = Math.max(
      Number.EPSILON,
      Number(CONFIG.SPACEHOLDER?.movementMinDistancePerSlice) || 0.25
    );
    const travelDistPerSlice = Math.max(0, 5 + dexM);
    const distPerSliceForCost = Math.max(minDistPerSlice, travelDistPerSlice);
    systemData.speed = apSlice / distPerSliceForCost;

    systemData.derivedStats = {
      healthBonus: endM,
      carryWeight: Math.floor(15 + strV * 6 + val('end') * 5),
      liftWeight: Math.floor(strV * 12),
      meleeDamageBonus: strM,
      jumpHigh,
      jumpLong,
      travelSpeed: travelDistPerSlice,
      movementTimeSliceAp: apSlice,
      /** MVP: ходов за раунд (боёвка), не хранится в документе. */
      turnsPerRound: Math.max(1, Math.floor((dexV * intV) / 100)),
      agilityScore: 10 + dexM + corM,
      actionSpeed: Math.max(0, 8 + corM * 2),
      reactionScore: 10 + dexM + perM,
      accuracyScore: 10 + corM + perM,
      awarenessScore: 10 + perM * 2,
      learnRateScore: 10 + perM + intM,
      willScore: 10 + intM * 2,
      intuitionScore: 10 + lucM + intM,
      heroismPoints: Math.max(0, 1 + lucM),
      secondWindBonus: 1 + endM + lucM,
      /** Совпадает с `getMaxApFromAbilities` / макс. ОД в бою. */
      maxApFromAbilities: getMaxApFromAbilities(this),
    };
  }

  /**
   * Prepare body parts health system
   */
  _prepareBodyParts(systemData) {
    const isUnlinkedTokenActor = Boolean(this.isToken && this.token && this.token.actorLink === false);
    // В prepareDerivedData нельзя читать token.delta: это может инстанцировать ActorDelta
    // и рекурсивно вызвать подготовку данных synthetic actor.
    const tokenDeltaBodyParts = this.token?._source?.delta?.system?.health?.bodyParts;
    const hasDeltaBodyPartsOverride = Boolean(
      this.token?._source?.delta?.system?.health &&
      Object.prototype.hasOwnProperty.call(this.token._source.delta.system.health, 'bodyParts')
    );
    if (
      isUnlinkedTokenActor &&
      hasDeltaBodyPartsOverride &&
      tokenDeltaBodyParts &&
      typeof tokenDeltaBodyParts === 'object'
    ) {
      // Для unlinked synthetic actor считаем delta-части тела источником истины.
      // Иначе Foundry deep-merge добавляет базовые части актёра к токеновым.
      const mergedBeforeCount = Object.keys(systemData?.health?.bodyParts ?? {}).length;
      systemData.health = systemData.health || {};
      systemData.health.bodyParts = foundry.utils.deepClone(tokenDeltaBodyParts);
    }

    // Основной источник состояния — травмы.
    const bodyParts = systemData.health?.bodyParts || {};
    const injuries = systemData.health?.injuries || [];

    if (!bodyParts || Object.keys(bodyParts).length === 0) {
      return;
    }

    // Построим map uuid -> slotRef для новых анатомий; для старых (без uuid) fallback на partId.
    const uuidToSlotRef = {};
    for (const [slotRef, part] of Object.entries(bodyParts)) {
      if (part?.uuid) uuidToSlotRef[part.uuid] = slotRef;
    }

    // Предварительно собираем сумму урона по частям (amount хранится в масштабе x100)
    const sumDamageByPart = {};
    for (const inj of injuries) {
      if (typeof inj?.amount !== 'number') continue;
      let key = null;
      if (inj.partUuid && uuidToSlotRef[inj.partUuid]) {
        key = uuidToSlotRef[inj.partUuid];
      } else if (inj.partId && bodyParts[inj.partId]) {
        key = inj.partId;
      }
      if (!key) continue;
      sumDamageByPart[key] = (sumDamageByPart[key] || 0) + Math.max(0, inj.amount | 0);
    }

    // Обновляем производные поля частей тела (typed relations + производные links; попадания — в shot-manager)
    for (const [partId, bodyPart] of Object.entries(bodyParts)) {
      ensureActorPartRelationsSynced(bodyPart);
      ensureActorPartBodyLayersSynced(bodyPart);
      const typeId = String(bodyPart?.id ?? "").trim();
      if (typeId) {
        bodyPart.displayName = resolveBodyPartDisplayName(typeId, bodyPart.name);
      }
      bodyPart.linkedPartIds = Array.isArray(bodyPart.links) ? [...bodyPart.links] : [];
      const parentRel = Array.isArray(bodyPart.relations)
        ? bodyPart.relations.find((r) => r && r.kind === "parent")
        : null;
      bodyPart.parentRef = parentRel?.target ?? null;

      // Вычисляем текущее здоровье из травм: current = maxHp - floor(sum(amount)/100)
      const sumAmt = sumDamageByPart[partId] || 0;
      const dmgUnits = Math.floor(sumAmt / 100); // Масштаб: x100 => целые единицы HP
      const currentHpDerived = Math.max(0, bodyPart.maxHp - dmgUnits);

      // Процент здоровья и статус — производные
      bodyPart.healthPercentage = bodyPart.maxHp > 0 ? Math.floor((currentHpDerived * 100) / bodyPart.maxHp) : 100;
      if (!bodyPart.status || bodyPart.status === 'healthy') {
        bodyPart.status = this._getBodyPartStatus({ healthPercentage: bodyPart.healthPercentage });
      }
    }
  }

  /**
   * Применить модификаторы характеристик от экипированных wearable-предметов.
   * Модификаторы влияют только на производные данные (runtime), не меняя сохранённый источник.
   */
  _applyWearableModifiers(systemData) {
    if (this.type !== 'character') return;

    const wearables = this.items.filter((i) => i.type === 'item' && i.system?.equipped);
    if (!wearables.length) return;

    const targetsCfg = CONFIG.SPACEHOLDER?.characterModifierTargets || {};
    const allTargets = [
      ...(targetsCfg.abilities || []),
      ...(targetsCfg.derived || []),
      ...(targetsCfg.params || [])
    ];
    if (!allTargets.length) return;

    const sums = new Map();

    for (const item of wearables) {
      if (!item.system?.itemTags?.isModifiers) continue;
      const mods = item.system?.modifiers || {};
      const collect = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
          const id = String(m?.targetId ?? m?.id ?? '').trim();
          if (!id) continue;
          const mode = String(m?.mode || 'add').trim() || 'add';
          if (mode !== 'add') continue;
          const val = Number(m?.value ?? 0);
          if (!Number.isFinite(val) || val === 0) continue;
          sums.set(id, (sums.get(id) || 0) + val);
        }
      };
      collect(mods.abilities);
      collect(mods.derived);
      collect(mods.params);
    }

    if (!sums.size) return;

    for (const cfg of allTargets) {
      const id = String(cfg.id ?? '').trim();
      const path = String(cfg.path ?? '').trim();
      if (!id || !path) continue;
      const delta = sums.get(id);
      if (!delta) continue;
      const current = foundry.utils.getProperty(systemData, path);
      const base = Number.isFinite(Number(current)) ? Number(current) : 0;
      foundry.utils.setProperty(systemData, path, base + delta);
    }
  }

  /**
   * Добавить травму
   *
   * `amount` хранится как целое в масштабе x100 (125 = 1.25 единицы урона).
   *
   * @param {Object} [opts]
   * @param {string} [opts.partId]
   * @param {string} [opts.partUuid]
   * @param {number} [opts.amount]
   * @param {number} [opts.initialAmount] если не передано, приравнивается к `amount`
   * @param {string} [opts.type='unknown'] id из `DAMAGE_TYPES`
   * @param {'raw'|'treated'} [opts.status='raw']
   * @param {string|Object} [opts.source] либо строка-легаси, либо структурированный
   *   объект `{ attackerUuid, attackerName, weaponUuid, weaponName, ammoUuid,
   *   ammoName, verbKey, shotUid }` (любое поле опционально).
   */
  async addInjury({ partId, partUuid, amount, initialAmount, type = 'unknown', status = 'raw', source = '' } = {}) {
    const bodyParts = this.system.health?.bodyParts || {};
    if (!bodyParts || !Object.keys(bodyParts).length) return false;

    let resolvedSlotRef = null;
    let resolvedUuid = null;

    if (partUuid) {
      for (const [slotRef, part] of Object.entries(bodyParts)) {
        if (part?.uuid && part.uuid === partUuid) {
          resolvedSlotRef = slotRef;
          resolvedUuid = part.uuid;
          break;
        }
      }
      if (!resolvedSlotRef && bodyParts[partUuid]) {
        resolvedSlotRef = partUuid;
        resolvedUuid = bodyParts[partUuid]?.uuid || null;
      }
    }

    if (!resolvedSlotRef && partId) {
      const part = bodyParts[partId];
      if (part) {
        resolvedSlotRef = partId;
        resolvedUuid = part.uuid || null;
      }
    }

    if (!resolvedSlotRef) return false;

    const amt = Math.max(0, (amount ?? 0) | 0);
    const initAmt = Math.max(amt, (initialAmount ?? amt) | 0);
    const normalizedStatus = status === 'treated' ? 'treated' : 'raw';
    const normalizedSource = this._normalizeInjurySource(source);
    const injury = {
      id: foundry.utils.randomID?.() || randomID?.() || crypto.randomUUID?.() || String(Date.now()),
      partId: resolvedSlotRef,
      partUuid: resolvedUuid ?? undefined,
      amount: amt,
      initialAmount: initAmt,
      type,
      status: normalizedStatus,
      source: normalizedSource,
      createdAt: Date.now()
    };

    const injuries = Array.isArray(this.system.health?.injuries) ? foundry.utils.deepClone(this.system.health.injuries) : [];
    injuries.push(injury);
    await this.update({ 'system.health.injuries': injuries });
    return true;
  }

  /**
   * Нормализовать источник травмы: строка → `{ legacyLabel }`, объект клонируется.
   * Возвращаемое значение всегда пригодно для сериализации.
   * @param {string|Object|null|undefined} source
   * @returns {Object}
   */
  _normalizeInjurySource(source) {
    if (source == null || source === '') return {};
    if (typeof source === 'string') return { legacyLabel: source };
    if (typeof source !== 'object') return { legacyLabel: String(source) };
    const out = {};
    for (const key of [
      'attackerUuid', 'attackerName',
      'weaponUuid', 'weaponName',
      'ammoUuid', 'ammoName',
      'verbKey', 'shotUid', 'legacyLabel'
    ]) {
      const val = source[key];
      if (val == null || val === '') continue;
      out[key] = String(val);
    }
    return out;
  }

  /** Обновить травму по id */
  async updateInjury(injuryId, patch = {}) {
    if (!injuryId) return false;
    const injuries = Array.isArray(this.system.health?.injuries) ? foundry.utils.deepClone(this.system.health.injuries) : [];
    const idx = injuries.findIndex(i => i.id === injuryId);
    if (idx === -1) return false;

    // Масштаб amount сохраняем x100, если передан
    if (patch.hasOwnProperty('amount')) {
      patch.amount = Math.max(0, (patch.amount ?? 0) | 0);
    }

    if (patch.hasOwnProperty('status')) {
      patch.status = patch.status === 'treated' ? 'treated' : 'raw';
    }

    if (patch.hasOwnProperty('source')) {
      patch.source = this._normalizeInjurySource(patch.source);
    }

    injuries[idx] = { ...injuries[idx], ...patch };
    await this.update({ 'system.health.injuries': injuries });
    return true;
  }

  /** Удалить травму по id */
  async removeInjury(injuryId) {
    if (!injuryId) return false;
    const injuries = Array.isArray(this.system.health?.injuries) ? this.system.health.injuries : [];
    const filtered = injuries.filter(i => i.id !== injuryId);
    if (filtered.length === injuries.length) return false;
    await this.update({ 'system.health.injuries': filtered });
    return true;
  }

  /** Получить травмы по части тела */
  getInjuriesByPart(partId) {
    const injuries = Array.isArray(this.system.health?.injuries) ? this.system.health.injuries : [];
    return injuries.filter(i => i.partId === partId || i.partUuid === partId);
  }

  /** Текущее здоровье части тела (derived, без сохранения) */
  getCurrentHpForPart(partId) {
    const bodyPart = this.system.health?.bodyParts?.[partId];
    if (!bodyPart) return 0;
    const injuries = this.getInjuriesByPart(partId);
    const sumAmt = injuries.reduce((acc, i) => acc + (i.amount|0), 0);
    const dmgUnits = Math.floor(sumAmt / 100);
    return Math.max(0, bodyPart.maxHp - dmgUnits);
  }

  /**
   * Материал части тела (для выбора словаря описателя травмы).
   * Нормализует legacy-значения MVP-редактора (`flesh` / `cybernetic` /
   * `armor` / `other`) в канонические категории описателей:
   *   — `biological` — ветка кровотечения/заживления;
   *   — `bionic`     — ветка повреждения/ремонта.
   * Всё незнакомое трактуется как `biological`, чтобы описатели никогда
   * не получали неизвестный ключ. Слои тела `part.bodyLayers` сюда не
   * участвуют — это именно категория самой части, а не её тканей.
   * @param {Object} part
   * @returns {'biological'|'bionic'}
   */
  getPartMaterial(part) {
    if (!part || typeof part !== 'object') return 'biological';
    const raw = String(part.material ?? '').trim();
    if (!raw) return 'biological';
    if (raw === 'biological' || raw === 'bionic') return raw;
    if (raw === 'cybernetic') return 'bionic';
    // flesh / armor / other и любые неизвестные legacy-значения
    return 'biological';
  }

  /**
   * Собрать структурированное описание травмы для рендера в UI.
   * Возвращает `{ segments, tooltipSegments }` (и несколько служебных полей).
   * Реализация — в `helpers/damage/injury-description.mjs`; сюда вынесено,
   * чтобы `actor-sheet.mjs` не знал о реестре описателей.
   * @param {Object} injury
   * @returns {Object}
   */
  formatInjuryForDisplay(injury) {
    if (!injury || typeof injury !== 'object') return { segments: [], tooltipSegments: [] };
    const part = this.system?.health?.bodyParts?.[injury.partId] ?? null;
    const material = this.getPartMaterial(part);
    return describeInjury({ injury, part, material, actor: this });
  }

  /* ================================================================ *
   *  Damage / armour resolution                                       *
   * ================================================================ */

  /**
   * Resolve a damage package against the target's anatomy. Walks the
   * projectile through the hit body part — and potentially onward via
   * `relations.behind` — delegating to
   * {@link resolveBodyTraversal}. Each traversed part's armour layers
   * are persisted; each part that actually absorbed damage gets its own
   * `injury` record.
   *
   * Layer ordering within a single slot: outer → inner mirrors the
   * iteration order of {@link _collectLayerSourcesForSlot}. Within a
   * wearable, `system.coveredParts[i].layers` are taken in declared
   * order (first entry is outermost).
   *
   * @param {Object} options
   * @param {string} [options.partId]          - canonical slotRef (e.g. 'leftArm')
   * @param {string} [options.partUuid]        - alternative way to address a slot
   * @param {Object|Array<Object>} options.applications - either a phased
   *   array (`[{mode, items}]`), a flat item list, a legacy `{type,damage}`
   *   pair, or a `projectile` object. Anything `normalizeApplications`
   *   accepts works.
   * @param {Object} [options.projectile]      - alternative to `applications`:
   *   the system reads it via `buildProjectileApplications` so legacy
   *   `damage`/`damageType` stay supported.
   * @param {string} [options.builderId]       - if set, a registered
   *   builder in `CONFIG.SPACEHOLDER.applicationBuilders` is invoked to
   *   produce the package dynamically.
   * @param {Object} [options.builderContext]  - extra context passed to
   *   the builder (typically `{ weapon, ammo, attacker, target, channel }`).
   * @param {string|Object} [options.source]   - source descriptor for the
   *   resulting injury entry. Either a legacy string label or a structured
   *   object with `attackerName`/`weaponName`/`ammoName`/uuids/etc. See
   *   `addInjury` docstring for the accepted shape.
   * @param {string} [options.hitDirection='front'] - side of the body the
   *   projectile enters from. The v1 runtime does not yet read a real
   *   direction from the shot pipeline, but callers (and tests) may
   *   override it to exercise through-and-through behaviour.
   * @param {() => number} [options.random]    - injectable RNG.
   * @returns {Promise<{
   *   bodyDamage: Array<{type:string, amount:number}>,
   *   bodyDamageBySlot: Object<string, Array<{type:string, amount:number}>>,
   *   path: Array<Object>,
   *   trace: Array<Object>,
   *   slotRef: string|null
   * }>}
   *   `bodyDamage` is the merged damage for the **entry** slot (for
   *   backward compatibility with legacy callers that cared about one
   *   part only). `bodyDamageBySlot` is the full per-part breakdown,
   *   and `path` lists every visited slot with its entry/exit details.
   */
  async applyDamagePackage({
    partId,
    partUuid,
    applications,
    projectile,
    builderId,
    builderContext,
    source = '',
    hitDirection = 'front',
    random
  } = {}) {
    const bodyParts = this.system?.health?.bodyParts || {};
    const slotRef = this._resolveSlotRef({ partId, partUuid, bodyParts });
    if (!slotRef) {
      return { bodyDamage: [], bodyDamageBySlot: {}, path: [], trace: [], slotRef: null };
    }

    const package_ = this._composeApplicationPackage({ applications, projectile, builderId, builderContext });
    if (!package_.length) {
      return { bodyDamage: [], bodyDamageBySlot: {}, path: [], trace: [], slotRef };
    }

    const armorBySlot = this._collectArmorBySlot(bodyParts);
    const traversal = resolveBodyTraversal({
      anatomy: { bodyParts },
      startSlotRef: slotRef,
      hitDirection,
      applications: package_,
      armorBySlot,
      resolveMaterial: (id) => materialsManager.getMaterial(id),
      random
    });

    await this._persistTraversalArmorUpdates(traversal.armorUpdatesBySlot);

    for (const [partSlot, hits] of Object.entries(traversal.bodyDamageBySlot)) {
      if (!Array.isArray(hits) || !hits.length) continue;
      const totalAmount = Math.round(hits.reduce((sum, d) => sum + d.amount, 0) * 100);
      if (totalAmount <= 0) continue;
      const dominant = hits.reduce((acc, d) => (d.amount > (acc?.amount ?? 0) ? d : acc), null);
      await this.addInjury({
        partId: partSlot,
        amount: totalAmount,
        initialAmount: totalAmount,
        type: dominant?.type ?? 'unknown',
        status: 'raw',
        source: source || 'damage-package'
      });
    }

    return {
      bodyDamage: traversal.bodyDamageBySlot[slotRef] ?? [],
      bodyDamageBySlot: traversal.bodyDamageBySlot,
      path: traversal.path,
      trace: traversal.trace,
      slotRef
    };
  }

  /**
   * @param {Object} args
   * @returns {string|null}
   */
  _resolveSlotRef({ partId, partUuid, bodyParts }) {
    if (partId && bodyParts[partId]) return partId;
    if (partUuid) {
      for (const [slotRef, part] of Object.entries(bodyParts)) {
        if (part?.uuid === partUuid) return slotRef;
      }
      if (bodyParts[partUuid]) return partUuid;
    }
    return null;
  }

  /**
   * Build the canonical phased application package the resolver expects.
   * Builder registry takes precedence; then explicit `applications`; then
   * the legacy single-shot fallback baked into the projectile shape.
   */
  _composeApplicationPackage({ applications, projectile, builderId, builderContext }) {
    // Explicit builderId takes priority; the projectile's own builderId
    // (if any) is consulted by composeProjectileApplications below.
    if (builderId) {
      const registry = CONFIG?.SPACEHOLDER?.applicationBuilders ?? {};
      const fn = registry?.[builderId];
      if (typeof fn === 'function') {
        try {
          const built = fn({ ...(builderContext || {}), actor: this, projectile });
          const phases = normalizeApplications(built);
          if (phases.length) return phases;
        } catch (e) {
          console.error(`SpaceHolder | Application builder "${builderId}" failed:`, e);
        }
      } else {
        console.warn(`SpaceHolder | Unknown application builder id: ${builderId}`);
      }
    }
    if (applications != null) {
      const phases = normalizeApplications(applications);
      if (phases.length) return phases;
    }
    if (projectile && typeof projectile === 'object') {
      return composeProjectileApplications(projectile, { ...(builderContext || {}), actor: this });
    }
    return [];
  }

  /**
   * Walk equipped armour items covering `slotRef` and collect their layer
   * stacks in outermost-first order. Layers now live per body part inside
   * each `coveredParts[i].layers`; only the entry whose slotRef matches
   * `slotRef` (directly or via `resolveCoverageEntryToActorSlots`)
   * contributes layers.
   *
   * @param {string} slotRef
   * @returns {Array<{itemId: string, coverageIdx: number, layers: Array<Object>}>}
   */
  _collectLayerSourcesForSlot(slotRef) {
    const wearables = this.items?.filter?.((i) => i.type === 'item' && i.system?.equipped && i.system?.itemTags?.isArmor) ?? [];
    const sources = [];
    for (const item of wearables) {
      const coveredParts = Array.isArray(item.system?.coveredParts) ? item.system.coveredParts : [];
      for (let i = 0; i < coveredParts.length; i += 1) {
        const entry = coveredParts[i];
        const direct = String(entry?.slotRef ?? entry?.partId ?? '').trim();
        const matches = direct === slotRef
          || resolveCoverageEntryToActorSlots(this.system?.health?.bodyParts || {}, entry).slotRefs.includes(slotRef);
        if (!matches) continue;
        const rawLayers = Array.isArray(entry?.layers) ? entry.layers : [];
        const layers = rawLayers
          .map((layer) => {
            const md = materialsManager.getMaterial(layer?.material);
            return ensureLayerDefaults(layer, md);
          })
          .filter((l) => l.thickness > 0);
        if (!layers.length) continue;
        sources.push({ itemId: item.id, coverageIdx: i, layers });
      }
    }
    return sources;
  }

  /**
   * Collect equipped-armour layer sources for every slot that currently
   * exists on the actor. Returns a sparse map keyed by slotRef — slots
   * without any layers are omitted. Because the body-traversal resolver
   * cannot know which slots it will visit until it follows `behind`
   * relations at runtime, we hand it the full map up front.
   *
   * @param {Object<string, Object>} bodyParts
   * @returns {Object<string, Array<{itemId:string, coverageIdx:number, layers:Array}>>}
   */
  _collectArmorBySlot(bodyParts) {
    const out = {};
    const slots = bodyParts && typeof bodyParts === 'object' ? Object.keys(bodyParts) : [];
    for (const slot of slots) {
      const sources = this._collectLayerSourcesForSlot(slot);
      if (sources.length) out[slot] = sources;
    }
    return out;
  }

  /**
   * Persist armour updates returned by
   * {@link resolveBodyTraversal}. The traversal resolver yields a map
   * keyed by slotRef; each entry is the fresh `layers` state for every
   * `(itemId, coverageIdx)` pair that contributed to that slot. We
   * bucket them back to their source `item.system.coveredParts`
   * entries and issue one `Item#update` per affected item.
   *
   * Caveat: if a single `coveredParts[i]` covers multiple slots and the
   * projectile passed through several of them, the traversal resolver
   * runs each slot independently (starting from full integrity every
   * time), so the last slot's result wins here. v1 accepts that —
   * real anatomies generally split such cases into separate coverage
   * entries — but do not rely on cumulative shared-armour wear.
   *
   * @param {Object<string, Array<{itemId:string, coverageIdx:number, layers:Array}>>} armorUpdatesBySlot
   */
  async _persistTraversalArmorUpdates(armorUpdatesBySlot) {
    if (!armorUpdatesBySlot || typeof armorUpdatesBySlot !== 'object') return;

    const updatesByItem = new Map();
    for (const [, sources] of Object.entries(armorUpdatesBySlot)) {
      if (!Array.isArray(sources)) continue;
      for (const src of sources) {
        const itemId = String(src?.itemId ?? '');
        if (!itemId) continue;
        const item = this.items.get(itemId);
        if (!item) continue;
        const coverageIdx = Number(src?.coverageIdx ?? -1);
        if (!Number.isInteger(coverageIdx) || coverageIdx < 0) continue;
        const nextLayers = Array.isArray(src.layers) ? src.layers : [];
        const coveredParts = Array.isArray(item.system?.coveredParts) ? item.system.coveredParts : [];
        const entry = coveredParts[coverageIdx];
        if (!entry) continue;
        if (!updatesByItem.has(itemId)) {
          updatesByItem.set(itemId, { item, coveredParts: foundry.utils.deepClone(coveredParts) });
        }
        updatesByItem.get(itemId).coveredParts[coverageIdx].layers = nextLayers;
      }
    }

    for (const { item, coveredParts } of updatesByItem.values()) {
      const before = JSON.stringify(item.system?.coveredParts ?? []);
      const after = JSON.stringify(coveredParts);
      if (before === after) continue;
      try { await item.update({ 'system.coveredParts': coveredParts }); }
      catch (e) { console.error(`SpaceHolder | Failed to persist layers on ${item.name}:`, e); }
    }
  }

  /**
   * Get status description for body part
   */
  _getBodyPartStatus(bodyPart) {
    const percentage = bodyPart.healthPercentage;
    
    if (percentage === 0) return "destroyed";
    if (percentage < 25) return "badly_injured";
    if (percentage < 50) return "injured";
    if (percentage < 75) return "bruised";
    return "healthy";
  }





  /**
   * Stub: resolve hit location. Actual hit resolution will be implemented in shot-manager.
   * @param {string} targetPartId - ID of the target body part
   * @param {number} [_roll] - Unused; for future use
   * @returns {string} targetPartId
   */
  chanceHit(targetPartId, _roll = null) {
    const bodyParts = this.system.health?.bodyParts;
    if (!bodyParts || !bodyParts[targetPartId]) return targetPartId;
    return targetPartId;
  }

  /**
   * Stub: return first body part ID for legacy callers. Hit resolution will be in shot-manager.
   * @returns {string|null} First body part ID or null
   */
  getRootBodyPart() {
    const bodyParts = this.system.health?.bodyParts;
    if (!bodyParts || !Object.keys(bodyParts).length) return null;
    const sorted = Object.entries(bodyParts).sort((a, b) => (b[1].weight ?? 0) - (a[1].weight ?? 0));
    return sorted[0][0];
  }

  /**
   * Perform a hit against this actor (applies damage to given or first part).
   * @param {number} damage - Amount of damage to deal
   * @param {string|null} targetPart - Optional specific target part (defaults to first by weight)
   * @returns {Object|null} Hit result with final target and damage dealt
   */
  async performHit(damage, targetPart = null) {
    const partId = targetPart || this.getRootBodyPart();
    if (!partId) {
      console.warn("No valid body parts found for hit");
      return null;
    }
    const success = await this.applyBodyPartDamage(partId, damage);
    const bodyParts = this.system.health?.bodyParts;
    return {
      targetPart: partId,
      damage,
      success,
      bodyPart: bodyParts?.[partId]
    };
  }

  /**
   * Apply damage to a specific body part
   * @param {string} partId - Body part ID
   * @param {number} damage - Damage amount
   * @param {string} damageType - Type of damage (for different pain/bleeding calculations)
   * @returns {boolean} Success
   */
  async applyBodyPartDamage(partId, damage, damageType = 'blunt') {
    const bodyParts = this.system.health?.bodyParts;
    const bodyPart = bodyParts?.[partId];
    if (!bodyPart) return false;

    // Конвертируем урон в масштаб x100 для избежания ошибок float.
    // Пример: damage=1.25 => amount=125
    const amount = Math.max(0, Math.floor((damage ?? 0) * 100));

    await this.addInjury({
      partId,
      amount,
      type: damageType || 'blunt',
      status: 'raw',
      source: 'direct'
    });

    return true;
  }

  /**
   * Change anatomy type for this actor
   * @param {string} newAnatomyType - New anatomy type ID
   * @returns {boolean} Success
   */
  async changeAnatomyType(newAnatomyType) {
    // Для обратной совместимости: перенаправляем на setAnatomy
    return this.setAnatomy(newAnatomyType);
  }

  /**
   * Установить анатомию актёру (основной API)
   * @param {string} anatomyId 
   */
  async setAnatomy(anatomyId) {
    try {
      const anatomy = await anatomyManager.createActorAnatomy(anatomyId);
      const displayName = anatomyManager.getAnatomyDisplayName(anatomyId);
      
      const isUnlinkedTokenActor = Boolean(this.isToken && this.token && this.token.actorLink === false);
      if (isUnlinkedTokenActor && this.token?.update) {
        const currentDeltaParts = this.token?._source?.delta?.system?.health?.bodyParts ?? {};
        const currentMergedParts = this.system?.health?.bodyParts ?? {};
        const delUpdate = {};
        // Удаляем и ключи из текущего delta, и ключи из merged-состояния, чтобы не оставалось хвостов.
        const keysToDelete = new Set([
          ...Object.keys(currentDeltaParts),
          ...Object.keys(currentMergedParts)
        ]);
        const newSlotKeySet = new Set(Object.keys(anatomy.bodyParts ?? {}));
        // ActorDelta: в одном update нельзя совмещать ForcedDeletion слота и запись
        // того же слота — иначе для совпадающих слотов (например head#1) в дельте
        // оказываются пустые объекты.
        for (const id of keysToDelete) {
          if (newSlotKeySet.has(id)) continue;
          delUpdate[`delta.system.health.bodyParts.${id}`] = new foundry.data.operators.ForcedDeletion();
        }
        delUpdate['delta.system.anatomy.id'] = anatomyId;
        delUpdate['delta.system.anatomy.name'] = displayName;
        delUpdate['delta.system.anatomy.type'] = anatomyId;
        // Записываем bodyParts по ключам, чтобы избежать merge целого объекта в ActorDelta.
        for (const [slotRef, partData] of Object.entries(anatomy.bodyParts ?? {})) {
          delUpdate[`delta.system.health.bodyParts.${slotRef}`] = partData;
        }
        delUpdate['delta.system.health.injuries'] = [];
        if (anatomy.grid && typeof anatomy.grid.width === 'number' && typeof anatomy.grid.height === 'number') {
          delUpdate['delta.system.health.anatomyGrid'] = { width: anatomy.grid.width, height: anatomy.grid.height };
        }
        await this.token.update(delUpdate);
      } else {
        // Для обычного actor-контекста оставляем обновление через actor.update.
        await this.update({ 'system.health.bodyParts': new foundry.data.operators.ForcedDeletion() });
        
        // Устанавливаем сведения об анатомии, сетку (если есть в шаблоне) и новые части
        const update = {
          'system.anatomy.id': anatomyId,
          'system.anatomy.name': displayName,
          'system.anatomy.type': anatomyId,
          'system.health.bodyParts': anatomy.bodyParts,
          // Травмы привязаны к slotRef/uuid старой анатомии, очищаем при полной замене.
          'system.health.injuries': []
        };
        if (anatomy.grid && typeof anatomy.grid.width === 'number' && typeof anatomy.grid.height === 'number') {
          update['system.health.anatomyGrid'] = { width: anatomy.grid.width, height: anatomy.grid.height };
        }
        await this.update(update);
      }
      
      // Пересчёт данных
      await this.prepareData();
      
      console.log(`Set anatomy '${anatomyId}' for actor ${this.name}`);
      return true;
    } catch (error) {
      console.error(`Failed to set anatomy for actor ${this.name}:`, error);
      return false;
    }
  }

  /**
   * Полный сброс анатомии (очистка всех частей тела и здоровья)
   * @param {boolean} clearType - также очистить system.anatomy.type
   * @returns {Promise<boolean>}
   */
  async resetAnatomy(clearType = true) {
    try {
      const isUnlinkedTokenActor = Boolean(this.isToken && this.token && this.token.actorLink === false);
      if (isUnlinkedTokenActor && this.token?.update) {
        const currentDeltaParts = this.token?._source?.delta?.system?.health?.bodyParts ?? {};
        const currentMergedParts = this.system?.health?.bodyParts ?? {};
        const deltaUpdate = {};
        const keysToDelete = new Set([
          ...Object.keys(currentDeltaParts),
          ...Object.keys(currentMergedParts)
        ]);
        for (const id of keysToDelete) {
          deltaUpdate[`delta.system.health.bodyParts.${id}`] = new foundry.data.operators.ForcedDeletion();
        }
        if (clearType) {
          deltaUpdate['delta.system.anatomy.id'] = null;
          deltaUpdate['delta.system.anatomy.name'] = null;
          deltaUpdate['delta.system.anatomy.type'] = null;
        }
        // Шаг 1: удаляем все известные ключи и анатомию.
        await this.token.update(deltaUpdate);
        // Шаг 2: создаём явный пустой override, чтобы synthetic actor не фоллбэчился к базовому bodyParts.
        await this.token.update({ 'delta.system.health.bodyParts': {} });
      } else {
        // Удаляем bodyParts целиком, чтобы не сохранялись унаследованные ключи в synthetic actor.
        const delUpdate = { 'system.health.bodyParts': new foundry.data.operators.ForcedDeletion() };
        if (clearType) {
          delUpdate['system.anatomy.id'] = null;
          delUpdate['system.anatomy.name'] = null;
          delUpdate['system.anatomy.type'] = null;
        }
        await this.update(delUpdate);
      }
      await this.prepareData();
      console.log(`Anatomy reset for actor ${this.name}${clearType ? ' (type cleared)' : ''}`);
      return true;
    } catch (error) {
      console.error(`Failed to reset anatomy for actor ${this.name}:`, error);
      return false;
    }
  }

  /**
   * Alias для совместимости
   */
  async clearAnatomy(clearType = true) {
    return this.resetAnatomy(clearType);
  }

  /**
   * Prepare NPC type specific data.
   */
  _prepareNpcData(actorData) {
    if (actorData.type !== 'npc') return;

    // Make modifications to data here. For example:
    const systemData = actorData.system;
    this._prepareAbilityModifiers(systemData);
    systemData.xp = systemData.cr * systemData.cr * 100;
  }

  /**
   * Override getRollData() that's supplied to rolls.
   */
  getRollData() {
    // Starts off by populating the roll data with a shallow copy of `this.system`
    const data = { ...this.system };

    // Prepare character roll data.
    this._getCharacterRollData(data);
    this._getNpcRollData(data);

    return data;
  }

  /**
   * Prepare character roll data.
   */
  _getCharacterRollData(data) {
    if (this.type !== 'character') return;

    // Copy the ability scores to the top level, so that rolls can use
    // formulas like `@str.mod + 4`.
    if (data.abilities) {
      for (let [k, v] of Object.entries(data.abilities)) {
        data[k] = foundry.utils.deepClone(v);
      }
    }

    // Add level for easier access, or fall back to 0.
    if (data.attributes.level) {
      data.lvl = data.attributes.level.value ?? 0;
    }

    if (data.derivedStats) {
      data.derived = foundry.utils.deepClone(data.derivedStats);
    }
  }

  /**
   * Prepare NPC roll data.
   */
  _getNpcRollData(data) {
    if (this.type !== 'npc') return;

    // Process additional NPC data here.
  }
}