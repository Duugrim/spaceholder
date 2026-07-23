/**
 * Antivirus state machine for the hacking minigame.
 *
 * Activation: primary AV occupies the rightmost column, then immediately scans
 * each of those cells.
 *
 * Each later tick: every agent moves (primary ← left, secondary → right) and
 * scans the destination on arrival.
 *
 * Primary that would leave past the leftmost column respawns on the rightmost
 * column of the same row (and scans there).
 *
 * Scan:
 * - captured → value 0, status untouched; primary also spawns a secondary here
 * - disabled (traversed) → untouched
 * Secondary never spawns further AV, and is removed after it zeros a captured cell.
 */

import { cellKey, getCell } from './hack-moves.mjs';

/**
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {{ r: number, c: number }[]} touched
 * @returns {boolean} true if AV was newly activated this call
 */
export function maybeActivateAntivirus(session, touched) {
  if (!session.antivirusEnabled || session.antivirusActive) return false;

  for (const pos of touched) {
    const cell = getCell(session, pos.r, pos.c);
    if (cell?.scannable) {
      activateAntivirus(session);
      return true;
    }
  }
  return false;
}

/**
 * Occupy the rightmost column with primary AV and scan each cell.
 * @param {import('./hack-board.mjs').HackSession} session
 */
export function activateAntivirus(session) {
  session.antivirusActive = true;
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      cell.scannable = false;
      cell.activeAntivirus = false;
      cell.antivirusSecondary = false;
      cell.antivirusFatigue = false;
    }
  }

  const rightCol = session.cols - 1;
  /** @type {Set<string>} */
  const secondaryKeys = new Set();
  for (let r = 0; r < session.rows; r++) {
    const cell = getCell(session, r, rightCol);
    if (!cell) continue;
    cell.activeAntivirus = true;
    scanCell(session, cell, true, secondaryKeys);
  }
  for (const key of secondaryKeys) {
    const [rs, cs] = key.split(',').map(Number);
    const cell = getCell(session, rs, cs);
    if (cell) cell.antivirusSecondary = true;
  }
  syncAntivirusActiveFlag(session);
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {object} cell
 * @param {boolean} canSpawnSecondary
 * @param {Set<string>} secondaryKeys
 * @returns {boolean} true if a captured cell was zeroed
 */
function scanCell(session, cell, canSpawnSecondary, secondaryKeys) {
  if (!cell) return false;
  if (cell.status === 'captured') {
    cell.value = 0;
    cell.status = 'untouched';
    if (canSpawnSecondary) secondaryKeys.add(cellKey(cell.r, cell.c));
    return true;
  }
  if (cell.status === 'traversed') {
    cell.status = 'untouched';
  }
  return false;
}

/**
 * One antivirus tick after a player capture (not on the spawn turn).
 * Simultaneous snapshot: move, then scan destinations.
 * @param {import('./hack-board.mjs').HackSession} session
 */
export function tickAntivirus(session) {
  if (!session.antivirusEnabled || !session.antivirusActive) return;

  /** @type {{ r: number, c: number, secondary: boolean }[]} */
  const agents = [];
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (cell.activeAntivirus) agents.push({ r, c, secondary: false });
      if (cell.antivirusSecondary) agents.push({ r, c, secondary: true });
    }
  }
  if (!agents.length) {
    session.antivirusActive = false;
    return;
  }

  const rightCol = session.cols - 1;

  /** @type {Set<string>} */
  const nextPrimary = new Set();
  /** @type {Set<string>} */
  const nextSecondary = new Set();
  /** @type {{ r: number, c: number, secondary: boolean }[]} */
  const arrivals = [];

  for (const agent of agents) {
    if (agent.secondary) {
      const nr = agent.r;
      const nc = agent.c + 1;
      const dest = getCell(session, nr, nc);
      if (!dest) continue; // secondary left the board on the right
      const key = cellKey(nr, nc);
      nextSecondary.add(key);
      arrivals.push({ r: nr, c: nc, secondary: true });
      continue;
    }

    // Primary: step left; past the left edge → respawn on the rightmost column.
    const nr = agent.r;
    let nc = agent.c - 1;
    if (nc < 0) nc = rightCol;
    const dest = getCell(session, nr, nc);
    if (!dest) continue;
    const key = cellKey(nr, nc);
    nextPrimary.add(key);
    arrivals.push({ r: nr, c: nc, secondary: false });
  }

  // Clear old presence, apply moves.
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      cell.activeAntivirus = false;
      cell.antivirusSecondary = false;
    }
  }
  for (const key of nextPrimary) {
    const [r, c] = key.split(',').map(Number);
    const cell = getCell(session, r, c);
    if (cell) cell.activeAntivirus = true;
  }
  for (const key of nextSecondary) {
    const [r, c] = key.split(',').map(Number);
    const cell = getCell(session, r, c);
    if (cell) cell.antivirusSecondary = true;
  }

  // Scan each arrival (dedupe per cell: prefer primary scan so it can spawn).
  /** @type {Map<string, boolean>} key → canSpawnSecondary */
  const scanSpawn = new Map();
  for (const arrival of arrivals) {
    const key = cellKey(arrival.r, arrival.c);
    const canSpawn = !arrival.secondary;
    scanSpawn.set(key, (scanSpawn.get(key) ?? false) || canSpawn);
  }
  /** @type {Set<string>} */
  const spawnedSecondary = new Set();
  /** @type {Set<string>} */
  const secondaryExhausted = new Set();
  for (const [key, canSpawn] of scanSpawn) {
    const [r, c] = key.split(',').map(Number);
    const cell = getCell(session, r, c);
    if (!cell) continue;
    const didZero = scanCell(session, cell, canSpawn, spawnedSecondary);
    // Secondary that zeros a captured cell disappears after that one zeroing.
    if (didZero && !canSpawn) secondaryExhausted.add(key);
  }
  for (const key of spawnedSecondary) {
    const [r, c] = key.split(',').map(Number);
    const cell = getCell(session, r, c);
    if (cell) cell.antivirusSecondary = true;
  }
  for (const key of secondaryExhausted) {
    if (spawnedSecondary.has(key)) continue;
    const [r, c] = key.split(',').map(Number);
    const cell = getCell(session, r, c);
    if (cell) cell.antivirusSecondary = false;
  }

  syncAntivirusActiveFlag(session);
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 */
function syncAntivirusActiveFlag(session) {
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (cell.activeAntivirus || cell.antivirusSecondary) {
        session.antivirusActive = true;
        return;
      }
    }
  }
  session.antivirusActive = false;
}

/**
 * Whether any AV agent remains on the board.
 * @param {import('./hack-board.mjs').HackSession} session
 */
export function hasAntivirusAgents(session) {
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (cell.activeAntivirus || cell.antivirusSecondary) return true;
    }
  }
  return false;
}
