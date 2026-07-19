/**
 * Antivirus state machine for the hacking minigame.
 */

import { cellKey, getCell } from './hack-moves.mjs';

/**
 * After a capture: if any newly touched scannable cell was hit, activate AV.
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {{ r: number, c: number }[]} touched
 * @returns {boolean} true if AV was newly activated this call
 */
export function maybeActivateAntivirus(session, touched) {
  if (!session.antivirusEnabled || session.antivirusActive) return false;

  for (const pos of touched) {
    const cell = getCell(session, pos.r, pos.c);
    if (cell?.scannable && !cell.antivirusImmune) {
      activateAntivirus(session);
      return true;
    }
  }
  return false;
}

/**
 * @param {object} cell
 * @returns {boolean}
 */
function isAvBlocked(cell) {
  return !!cell?.antivirusImmune;
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 */
export function activateAntivirus(session) {
  session.antivirusActive = true;
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      cell.scannable = false;
      cell.activeAntivirus = false;
      cellClearFatigue(cell);
    }
  }
  const top = getCell(session, 0, session.cols - 1);
  const bot = getCell(session, session.rows - 1, session.cols - 1);
  if (top && !isAvBlocked(top)) top.activeAntivirus = true;
  if (bot && session.rows > 1 && !isAvBlocked(bot)) bot.activeAntivirus = true;
  syncAntivirusActiveFlag(session);
}

/**
 * @param {object} cell
 */
function cellClearFatigue(cell) {
  cell.antivirusFatigue = false;
}

/**
 * One antivirus tick after a player capture.
 * Not run on the spawn turn (activation only places corner seeds).
 *
 * Simultaneous snapshot resolution.
 * Cells that die gain one-tick fatigue so holes are not instantly refilled
 * (prevents perpetual fringe churn).
 *
 * @param {import('./hack-board.mjs').HackSession} session
 */
export function tickAntivirus(session) {
  if (!session.antivirusEnabled || !session.antivirusActive) return;

  /** @type {{ r: number, c: number }[]} */
  const agents = [];
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      if (session.cells[r][c].activeAntivirus) agents.push({ r, c });
    }
  }
  if (!agents.length) {
    session.antivirusActive = false;
    return;
  }

  const agentKeys = new Set(agents.map((p) => cellKey(p.r, p.c)));

  /** @type {{ r: number, c: number, kind: 'traverse'|'zero' }[]} */
  const scans = [];
  /** @type {Map<string, { r: number, c: number }>} */
  const spreadMap = new Map();
  /** @type {{ r: number, c: number }[]} */
  const dies = [];

  for (const pos of agents) {
    const cell = getCell(session, pos.r, pos.c);
    if (!cell) continue;

    // Purple-warded cells purge any AV presence and never act.
    if (isAvBlocked(cell)) {
      dies.push(pos);
      continue;
    }

    if (cell.status === 'traversed') {
      scans.push({ r: pos.r, c: pos.c, kind: 'traverse' });
      continue;
    }
    // On a captured cell: zero its value (spread still treats captured ≡ untouched).
    if (cell.status === 'captured' && cell.value > 0) {
      scans.push({ r: pos.r, c: pos.c, kind: 'zero' });
      continue;
    }

    const targets = collectSpreadTargets(session, pos.r, pos.c, agentKeys);
    if (targets.length) {
      for (const t of targets) spreadMap.set(cellKey(t.r, t.c), t);
      continue;
    }

    dies.push(pos);
  }

  for (const scan of scans) {
    const cell = getCell(session, scan.r, scan.c);
    if (!cell || isAvBlocked(cell)) continue;
    if (scan.kind === 'traverse') cell.status = 'untouched';
    else cell.value = 0;
  }

  for (const pos of spreadMap.values()) {
    const cell = getCell(session, pos.r, pos.c);
    if (!cell || isAvBlocked(cell)) continue;
    cell.activeAntivirus = true;
    cell.antivirusFatigue = false;
  }

  // Clear prior fatigue, then mark this tick's deaths as fatigued (blocked next tick)
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (!cell.activeAntivirus) cell.antivirusFatigue = false;
    }
  }

  for (const pos of dies) {
    const cell = getCell(session, pos.r, pos.c);
    if (!cell) continue;
    cell.activeAntivirus = false;
    cell.antivirusFatigue = true;
  }

  syncAntivirusActiveFlag(session);
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 */
function syncAntivirusActiveFlag(session) {
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      if (session.cells[r][c].activeAntivirus) {
        session.antivirusActive = true;
        return;
      }
    }
  }
  session.antivirusActive = false;
}

/**
 * Spread priority: (untouched | captured) → traversed.
 * For AV, captured cells are treated exactly like untouched.
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} r
 * @param {number} c
 * @param {Set<string>} agentKeys
 */
function collectSpreadTargets(session, r, c, agentKeys) {
  const open = neighborsMatching(session, r, c, agentKeys, (cell) => (
    cell.status === 'untouched' || cell.status === 'captured'
  ));
  if (open.length) return open;
  return neighborsMatching(session, r, c, agentKeys, (cell) => cell.status === 'traversed');
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} r
 * @param {number} c
 * @param {Set<string>} agentKeys
 * @param {(cell: object) => boolean} pred
 */
function neighborsMatching(session, r, c, agentKeys, pred) {
  const dirs = [
    { dr: -1, dc: 0 },
    { dr: 1, dc: 0 },
    { dr: 0, dc: -1 },
  ];
  /** @type {{ r: number, c: number }[]} */
  const out = [];
  for (const { dr, dc } of dirs) {
    const nr = r + dr;
    const nc = c + dc;
    const neighbor = getCell(session, nr, nc);
    if (!neighbor) continue;
    if (agentKeys.has(cellKey(nr, nc))) continue;
    if (isAvBlocked(neighbor)) continue;
    if (neighbor.antivirusFatigue) continue;
    if (!pred(neighbor)) continue;
    out.push({ r: nr, c: nc });
  }
  return out;
}
