import { ITEM_PILES_SH } from './constants.mjs';

function _safeNumber(raw, fallback = 0) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function _isPileTokenDoc(tokenDoc) {
  try {
    return !!(
      tokenDoc?.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT)?.isPile ||
      tokenDoc?.flags?.[ITEM_PILES_SH.FLAG_SCOPE]?.[ITEM_PILES_SH.FLAG_ROOT]?.isPile ||
      tokenDoc?.actor?.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT)?.isPile ||
      tokenDoc?.actor?.flags?.[ITEM_PILES_SH.FLAG_SCOPE]?.[ITEM_PILES_SH.FLAG_ROOT]?.isPile
    );
  } catch (_) {
    return false;
  }
}

function _pileTokenCenter(tokenDoc, gridSize) {
  const tx = _safeNumber(tokenDoc.x, NaN);
  const ty = _safeNumber(tokenDoc.y, NaN);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  const gs = Math.max(10, _safeNumber(gridSize, 100));
  const width = Math.max(1, _safeNumber(tokenDoc.width, 1)) * gs;
  const height = Math.max(1, _safeNumber(tokenDoc.height, 1)) * gs;
  return { x: tx + width / 2, y: ty + height / 2 };
}

/**
 * Find the center of the nearest item-pile token within a Euclidean radius (in grid cells) of a scene point.
 * Used for held-item drop merge into an existing pile near the actor.
 * @param {Scene} scene
 * @param {number} originX - scene X (e.g. actor token center)
 * @param {number} originY - scene Y
 * @param {number} [cellRadiusCells=2]
 * @param {number} [gridSize] - defaults to canvas.grid.size
 * @returns {{ x: number, y: number } | null} center coordinates suitable for dropData x/y merge detection
 */
export function findNearestPileDropPointWithinCells(scene, originX, originY, cellRadiusCells = 2, gridSize) {
  const gs = Math.max(10, _safeNumber(gridSize ?? (typeof canvas !== 'undefined' ? canvas?.grid?.size : null), 100));
  const radius = Math.max(0.001, _safeNumber(cellRadiusCells, 2)) * gs;
  const maxD2 = radius * radius;
  const docs = Array.isArray(scene?.tokens?.contents) ? scene.tokens.contents : [];

  let best = null;
  let bestD2 = Infinity;
  let bestId = '';
  const eps = 1e-4;

  for (const doc of docs) {
    if (!_isPileTokenDoc(doc)) continue;
    const c = _pileTokenCenter(doc, gs);
    if (!c) continue;
    const dx = c.x - originX;
    const dy = c.y - originY;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxD2) continue;
    const id = String(doc.id ?? '');
    if (!best || d2 < bestD2 - eps || (Math.abs(d2 - bestD2) <= eps && id.localeCompare(bestId) < 0)) {
      bestD2 = d2;
      best = c;
      bestId = id;
    }
  }
  return best;
}
