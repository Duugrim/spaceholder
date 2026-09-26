import {
  SKILL_CATEGORIES,
  SKILL_CUSTOM_WEIGHT,
  SKILL_LEVEL_MAX,
  SKILL_UNTRAINED_LEVEL,
  clampSkillLevel,
} from './skills-const.mjs';
import {
  computeSkillEffectFromPath,
  getCustomChildWeight,
  getNodeWeight,
  getPhysicalSkillTrees,
  getSkillChildIds,
  getSkillDescendantIds,
  getSkillNode,
  getSkillParentId,
  getSkillPath,
} from './skills-tree.mjs';

const CATEGORY_SET = new Set(SKILL_CATEGORIES);

function _forcedReplacement(value) {
  const FR = globalThis.foundry?.data?.operators?.ForcedReplacement;
  if (typeof FR?.create === 'function') return FR.create(value);
  return value;
}

function _randomId() {
  try { return globalThis.foundry?.utils?.randomID?.(); } catch (_) { /* ignore */ }
  try { return globalThis.crypto?.randomUUID?.(); } catch (_) { /* ignore */ }
  return `sk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, parentId: string|null, category: string, name: string, level: number }|null}
 */
export function sanitizeSkillExtra(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim() || _randomId();
  const parentId = String(raw.parentId ?? '').trim() || null;
  let category = String(raw.category ?? '').trim();
  if (!CATEGORY_SET.has(category)) {
    category = parentId ? 'physical' : 'mixed';
  }
  const name = String(raw.name ?? '').trim();
  const level = clampSkillLevel(raw.level);
  return { id, parentId, category, name, level };
}

/**
 * Runtime-normalize `system.skills` (does not persist).
 * @param {object} systemData
 */
export function normalizeSkillsData(systemData) {
  if (!systemData || typeof systemData !== 'object') return;
  const raw = (systemData.skills && typeof systemData.skills === 'object') ? systemData.skills : {};
  const srcLevels = (raw.levels && typeof raw.levels === 'object' && !Array.isArray(raw.levels)) ? raw.levels : {};
  const levels = {};
  for (const [key, val] of Object.entries(srcLevels)) {
    const id = String(key ?? '').trim();
    if (!id) continue;
    const level = clampSkillLevel(val);
    if (level > SKILL_UNTRAINED_LEVEL) levels[id] = level;
  }
  const extras = Array.isArray(raw.extras)
    ? raw.extras.map(sanitizeSkillExtra).filter(Boolean)
    : [];
  systemData.skills = { levels, extras };
}

/**
 * @param {object} actor
 * @returns {{ levels: Record<string, number>, extras: object[] }}
 */
export function readActorSkills(actor) {
  const raw = actor?.system?.skills;
  const levels = {};
  const src = (raw?.levels && typeof raw.levels === 'object' && !Array.isArray(raw.levels)) ? raw.levels : {};
  for (const [key, val] of Object.entries(src)) {
    const id = String(key ?? '').trim();
    if (!id) continue;
    const level = clampSkillLevel(val);
    if (level > SKILL_UNTRAINED_LEVEL) levels[id] = level;
  }
  const extras = Array.isArray(raw?.extras)
    ? raw.extras.map(sanitizeSkillExtra).filter(Boolean)
    : [];
  return { levels, extras };
}

function _findExtra(extras, extraId) {
  const id = String(extraId ?? '').trim();
  if (!id) return null;
  return extras.find((e) => e.id === id) ?? null;
}

/**
 * Preset node or extra level. Missing → 0.
 * @param {object} actor
 * @param {string} nodeId
 * @returns {number}
 */
export function getSkillLevel(actor, nodeId) {
  const id = String(nodeId ?? '').trim();
  if (!id) return SKILL_UNTRAINED_LEVEL;
  const { levels, extras } = readActorSkills(actor);
  if (Object.prototype.hasOwnProperty.call(levels, id)) return clampSkillLevel(levels[id]);
  const extra = _findExtra(extras, id);
  if (extra) return extra.level;
  return SKILL_UNTRAINED_LEVEL;
}

function _resolveLevel(levels, extras, id) {
  const key = String(id ?? '').trim();
  if (!key) return SKILL_LEVEL_MAX;
  if (Object.prototype.hasOwnProperty.call(levels, key)) return clampSkillLevel(levels[key]);
  const extra = _findExtra(extras, key);
  if (extra) return extra.level;
  return SKILL_UNTRAINED_LEVEL;
}

function _parentCap(levels, extras, nodeId) {
  const extra = _findExtra(extras, nodeId);
  if (extra) {
    return extra.parentId ? _resolveLevel(levels, extras, extra.parentId) : SKILL_LEVEL_MAX;
  }
  const parentId = getSkillParentId(nodeId);
  if (parentId) return _resolveLevel(levels, extras, parentId);
  return SKILL_LEVEL_MAX;
}

function _presetLevel(levels, nodeId) {
  return Object.prototype.hasOwnProperty.call(levels, nodeId)
    ? clampSkillLevel(levels[nodeId])
    : SKILL_UNTRAINED_LEVEL;
}

function _extraSubtreeIds(extras, rootId) {
  const ids = new Set([String(rootId ?? '').trim()].filter(Boolean));
  let grew = true;
  while (grew) {
    grew = false;
    for (const extra of extras) {
      if (!extra.parentId || ids.has(extra.id) || !ids.has(extra.parentId)) continue;
      ids.add(extra.id);
      grew = true;
    }
  }
  return ids;
}

/**
 * @param {object} actor
 * @param {string} nodeId
 * @returns {{ id: string, weight: number, labelKey?: string, name?: string, level: number }[]}
 */
export function getSkillEffectPath(actor, nodeId) {
  const id = String(nodeId ?? '').trim();
  if (!id) return [];
  const { levels, extras } = readActorSkills(actor);

  const extraChain = [];
  let walk = _findExtra(extras, id);
  const guard = new Set();
  while (walk && !guard.has(walk.id)) {
    guard.add(walk.id);
    extraChain.push(walk);
    if (!walk.parentId) break;
    const parentExtra = _findExtra(extras, walk.parentId);
    if (parentExtra) walk = parentExtra;
    else break;
  }
  extraChain.reverse();

  if (extraChain.length) {
    const first = extraChain[0];
    const presetPath = (first.parentId && getSkillNode(first.parentId))
      ? getSkillPath(first.parentId)
      : [];
    const steps = presetPath.map((node) => ({
      id: node.id,
      weight: getNodeWeight(node),
      labelKey: node.labelKey,
      level: _presetLevel(levels, node.id),
    }));
    for (const extra of extraChain) {
      const parentPreset = extra.parentId ? getSkillNode(extra.parentId) : null;
      steps.push({
        id: extra.id,
        weight: extra.parentId ? getCustomChildWeight(parentPreset) : 1,
        name: extra.name,
        level: extra.level,
      });
    }
    return steps;
  }

  const preset = getSkillPath(id);
  return preset.map((node) => ({
    id: node.id,
    weight: getNodeWeight(node),
    labelKey: node.labelKey,
    level: _presetLevel(levels, node.id),
  }));
}

/**
 * Weighted average along the root→node chain, including untrained (0) ancestors.
 * @param {object} actor
 * @param {string} nodeId
 * @returns {number}
 */
export function getSkillEffect(actor, nodeId) {
  return computeSkillEffectFromPath(getSkillEffectPath(actor, nodeId));
}

function _clampTree(levels, extras, changedId, newLevel) {
  const cap = clampSkillLevel(newLevel);
  const desc = getSkillDescendantIds(changedId);
  for (const id of desc) {
    const cur = _presetLevel(levels, id);
    if (cur > cap) {
      if (cap <= SKILL_UNTRAINED_LEVEL) delete levels[id];
      else levels[id] = cap;
    }
  }
  const under = _extraSubtreeIds(extras, changedId);
  under.delete(String(changedId ?? '').trim());
  let grew = true;
  while (grew) {
    grew = false;
    for (const extra of extras) {
      if (!under.has(extra.id)) continue;
      const parentLv = extra.parentId
        ? _resolveLevel(levels, extras, extra.parentId)
        : SKILL_LEVEL_MAX;
      if (extra.level > parentLv) {
        extra.level = parentLv;
        grew = true;
      }
    }
  }
}

async function _persistSkills(actor, levels, extras) {
  if (!actor?.update) return { levels, extras };
  await actor.update({
    'system.skills.levels': _forcedReplacement(levels),
    'system.skills.extras': extras,
  });
  return { levels, extras };
}

/**
 * Set a preset-node level and clamp descendants (incl. extras under the subtree).
 * @param {object} actor
 * @param {string} nodeId
 * @param {unknown} rawLevel
 */
export async function setSkillLevel(actor, nodeId, rawLevel) {
  const id = String(nodeId ?? '').trim();
  const { levels, extras } = readActorSkills(actor);
  const extra = _findExtra(extras, id);
  if (!id || (!getSkillNode(id) && !extra)) return { levels, extras };
  const cap = _parentCap(levels, extras, id);
  const next = Math.min(clampSkillLevel(rawLevel), cap);
  if (extra) {
    extra.level = next;
    _clampTree(levels, extras, id, next);
    return _persistSkills(actor, levels, extras);
  }
  if (next <= SKILL_UNTRAINED_LEVEL) delete levels[id];
  else levels[id] = next;
  _clampTree(levels, extras, id, next);
  return _persistSkills(actor, levels, extras);
}

/**
 * @param {object} actor
 * @param {{ parentId?: string|null, category?: string, name?: string, level?: unknown }} spec
 */
export async function addSkillExtra(actor, spec = {}) {
  const { levels, extras } = readActorSkills(actor);
  const parentId = String(spec.parentId ?? '').trim() || null;
  let category = String(spec.category ?? '').trim();
  if (parentId) {
    const parentExtra = _findExtra(extras, parentId);
    if (parentExtra) category = parentExtra.category;
    else if (getSkillNode(parentId)) category = 'physical';
  }
  if (!CATEGORY_SET.has(category)) category = 'mixed';
  const parentLv = parentId ? _resolveLevel(levels, extras, parentId) : SKILL_LEVEL_MAX;
  const extra = sanitizeSkillExtra({
    id: _randomId(),
    parentId,
    category,
    name: spec.name,
    level: Math.min(clampSkillLevel(spec.level), parentLv),
  });
  extras.push(extra);
  return _persistSkills(actor, levels, extras);
}

/**
 * @param {object} actor
 * @param {string} extraId
 * @param {{ name?: string, level?: unknown }} patch
 */
export async function updateSkillExtra(actor, extraId, patch = {}) {
  const id = String(extraId ?? '').trim();
  if (!id) return readActorSkills(actor);
  const { levels, extras } = readActorSkills(actor);
  const extra = _findExtra(extras, id);
  if (!extra) return { levels, extras };
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    extra.name = String(patch.name ?? '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'level')) {
    const cap = extra.parentId
      ? _resolveLevel(levels, extras, extra.parentId)
      : SKILL_LEVEL_MAX;
    extra.level = Math.min(clampSkillLevel(patch.level), cap);
    _clampTree(levels, extras, extra.id, extra.level);
  }
  return _persistSkills(actor, levels, extras);
}

/**
 * @param {object} actor
 * @param {string} extraId
 */
export async function removeSkillExtra(actor, extraId) {
  const id = String(extraId ?? '').trim();
  const { levels, extras } = readActorSkills(actor);
  const drop = _extraSubtreeIds(extras, id);
  const nextExtras = extras.filter((e) => !drop.has(e.id));
  return _persistSkills(actor, levels, nextExtras);
}

function _localize(key, fallback) {
  const loc = globalThis.game?.i18n?.localize?.(key);
  if (loc && loc !== key) return loc;
  return fallback ?? key;
}

function _roundEffect(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.0';
  return v.toFixed(1);
}

/**
 * Sheet-ready physical trees + category extras.
 * @param {object} actor
 * @param {{ editable?: boolean, fold?: Record<string, boolean> }} [opts]
 */
export function buildSkillsSheetContext(actor, opts = {}) {
  const editable = opts.editable !== false;
  const fold = (opts.fold && typeof opts.fold === 'object') ? opts.fold : {};
  const { levels, extras } = readActorSkills(actor);
  const extrasByParent = new Map();
  const rootExtras = { physical: [], mixed: [], knowledge: [] };
  for (const extra of extras) {
    if (extra.parentId) {
      const list = extrasByParent.get(extra.parentId) ?? [];
      list.push(extra);
      extrasByParent.set(extra.parentId, list);
    } else if (rootExtras[extra.category]) {
      rootExtras[extra.category].push(extra);
    }
  }

  const isCollapsed = (id, depth, hasChildren) => {
    if (!hasChildren) return false;
    if (Object.prototype.hasOwnProperty.call(fold, id)) return !!fold[id];
    return depth >= 2;
  };

  const decorateExtraNode = (extra, depth) => {
    const nested = (extrasByParent.get(extra.id) ?? []).map((e) => decorateExtraNode(e, depth + 1));
    const hasChildren = nested.length > 0;
    const emptyName = !String(extra.name ?? '').trim();
    return {
      id: extra.id,
      isExtra: true,
      category: extra.category,
      parentId: extra.parentId,
      label: emptyName ? _localize('SPACEHOLDER.Skills.ExtraName', extra.id) : extra.name,
      nameEmpty: emptyName,
      depth,
      level: extra.level,
      maxLevel: extra.parentId ? _resolveLevel(levels, extras, extra.parentId) : SKILL_LEVEL_MAX,
      effect: _roundEffect(getSkillEffect(actor, extra.id)),
      hasChildren,
      collapsed: isCollapsed(extra.id, depth, hasChildren),
      children: nested,
    };
  };

  const decorateNode = (node, depth) => {
    const id = node.id;
    const extraKids = (extrasByParent.get(id) ?? []).map((e) => decorateExtraNode(e, depth + 1));
    const presetKids = (Array.isArray(node.children) ? node.children : [])
      .map((c) => decorateNode(c, depth + 1));
    const children = [...presetKids, ...extraKids];
    const hasChildren = children.length > 0;
    const parentId = getSkillParentId(id);
    return {
      id,
      isExtra: false,
      category: 'physical',
      parentId,
      labelKey: node.labelKey,
      label: _localize(node.labelKey, id),
      nameEmpty: false,
      depth,
      level: _presetLevel(levels, id),
      maxLevel: parentId ? _resolveLevel(levels, extras, parentId) : SKILL_LEVEL_MAX,
      effect: _roundEffect(getSkillEffect(actor, id)),
      hasChildren,
      collapsed: isCollapsed(id, depth, hasChildren),
      children,
    };
  };

  return {
    editable,
    physicalTrees: getPhysicalSkillTrees().map((root) => decorateNode(root, 0)),
    physicalExtras: rootExtras.physical.map((e) => decorateExtraNode(e, 0)),
    mixedExtras: rootExtras.mixed.map((e) => decorateExtraNode(e, 0)),
    knowledgeExtras: rootExtras.knowledge.map((e) => decorateExtraNode(e, 0)),
    customWeight: SKILL_CUSTOM_WEIGHT,
  };
}
