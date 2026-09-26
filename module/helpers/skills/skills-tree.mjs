import { PHYSICAL_SKILL_TREES } from './physical-tree.mjs';
import { SKILL_CUSTOM_WEIGHT, SKILL_UNTRAINED_LEVEL, clampSkillLevel } from './skills-const.mjs';

/**
 * @typedef {{ id: string, weight: number, labelKey: string, allowCustom?: boolean, customWeight?: number, children?: object[] }} SkillTreeNode
 */

/** @type {Map<string, SkillTreeNode>} */
const _byId = new Map();
/** @type {Map<string, string|null>} */
const _parentOf = new Map();
/** @type {Map<string, string[]>} */
const _childIds = new Map();

function _indexNode(node, parentId) {
  if (!node || typeof node !== 'object') return;
  const id = String(node.id ?? '').trim();
  if (!id) return;
  _byId.set(id, node);
  _parentOf.set(id, parentId);
  const kids = Array.isArray(node.children) ? node.children : [];
  _childIds.set(id, kids.map((c) => String(c?.id ?? '').trim()).filter(Boolean));
  for (const child of kids) _indexNode(child, id);
}

for (const root of PHYSICAL_SKILL_TREES) _indexNode(root, null);

/**
 * @returns {readonly object[]}
 */
export function getPhysicalSkillTrees() {
  return PHYSICAL_SKILL_TREES;
}

/**
 * @param {string} nodeId
 * @returns {SkillTreeNode|null}
 */
export function getSkillNode(nodeId) {
  const id = String(nodeId ?? '').trim();
  return id ? (_byId.get(id) ?? null) : null;
}

/**
 * @param {string} nodeId
 * @returns {string|null}
 */
export function getSkillParentId(nodeId) {
  const id = String(nodeId ?? '').trim();
  if (!id || !_parentOf.has(id)) return null;
  return _parentOf.get(id) ?? null;
}

/**
 * Preset children ids (not extras).
 * @param {string} nodeId
 * @returns {string[]}
 */
export function getSkillChildIds(nodeId) {
  const id = String(nodeId ?? '').trim();
  return _childIds.get(id) ? [..._childIds.get(id)] : [];
}

/**
 * Root → node (preset nodes only). Empty if id is unknown.
 * @param {string} nodeId
 * @returns {SkillTreeNode[]}
 */
export function getSkillPath(nodeId) {
  const id = String(nodeId ?? '').trim();
  if (!id || !_byId.has(id)) return [];
  const chain = [];
  let cur = id;
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const node = _byId.get(cur);
    if (!node) break;
    chain.push(node);
    cur = _parentOf.get(cur) ?? null;
  }
  chain.reverse();
  return chain;
}

/**
 * All descendant preset ids, breadth-first (not including `nodeId`).
 * @param {string} nodeId
 * @returns {string[]}
 */
export function getSkillDescendantIds(nodeId) {
  const start = String(nodeId ?? '').trim();
  if (!start) return [];
  const out = [];
  const queue = [...getSkillChildIds(start)];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...getSkillChildIds(id));
  }
  return out;
}

/**
 * @param {SkillTreeNode|null|undefined} node
 * @returns {number}
 */
export function getNodeWeight(node) {
  const w = Number(node?.weight);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * @param {SkillTreeNode|null|undefined} parentNode
 * @returns {number}
 */
export function getCustomChildWeight(parentNode) {
  const w = Number(parentNode?.customWeight);
  if (Number.isFinite(w) && w > 0) return w;
  return SKILL_CUSTOM_WEIGHT;
}

/**
 * Weighted average along `path` (zeros included). Empty path → 0.
 * @param {{ weight: number, level: number }[]} path
 * @returns {number}
 */
export function computeSkillEffectFromPath(path) {
  if (!Array.isArray(path) || !path.length) return 0;
  let wSum = 0;
  let lwSum = 0;
  for (const step of path) {
    const w = Number(step?.weight);
    const weight = Number.isFinite(w) && w > 0 ? w : 1;
    const level = clampSkillLevel(step?.level ?? SKILL_UNTRAINED_LEVEL);
    wSum += weight;
    lwSum += level * weight;
  }
  if (wSum <= 0) return 0;
  return lwSum / wSum;
}
