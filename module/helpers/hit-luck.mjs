/**
 * Aiming-arc luck zones and the projectile collision walk.
 *
 * The zone says how confidently a shot was taken (`AimingManager._currentShotLuck`); it is *not* part
 * of the hit quality (how centrally the hitbox was met — `hit-quality.mjs`). The walk below decides,
 * in flight order, which of the touched tokens a projectile really reaches; a caller may let it fly
 * past a token with `judgeToken` (the hook the shot-confidence / hit-resistance model plugs into).
 * A projectile that leaves a body flies on with what is left of it: `followProjectileThroughBodies`.
 */

export const HIT_LUCK_ZONE_ORDER = Object.freeze([
  'purple',
  'green',
  'yellow',
  'orange',
  'red',
]);

export function normalizeLuckZone(raw) {
  const z = String(raw ?? '').toLowerCase().trim();
  return HIT_LUCK_ZONE_ORDER.includes(z) ? z : 'green';
}

/**
 * Clock hours relative to target facing (12 = facing = front).
 * Hours 9–3 via 12 → front; 3–9 via 6 → back.
 * @param {number} clock
 * @returns {'front'|'back'}
 */
export function clockToHitFace(clock) {
  const n = Number(clock);
  if (!Number.isFinite(n)) return 'front';
  let hours = n % 12;
  if (hours < 0) hours += 12;
  if (hours > 3 && hours < 9) return 'back';
  return 'front';
}

/**
 * Walk a projectile segment's collisions in flight order and return the ones that really
 * touch it:
 * - a wall ends the walk (nothing behind it is reachable) — unless a `wallPlan`
 *   (walls/wall-penetration.mjs `planWallPasses`) lets the projectile through it: a passed wall is
 *   skipped, a wall that holds ends the walk at the point the plan gives;
 * - with a `judgeToken` hook, a token it lets the projectile fly past is skipped for the rest of
 *   the shot (`passedTokens`, listed in `passedThrough` for the chat); without it every touched
 *   token is a hit;
 * - `stop` / `need` end the walk at the first token that is really hit, `next` keeps piercing
 *   until a wall.
 * Tokens behind passed walls get `details.carry`: the projectile (applications) that is left after
 * those walls.
 *
 * @param {Array<{type: string, object?: any, point?: object, details?: object}>} collisions
 *   sorted by distance from the segment start
 * @param {string} onHit segment `onHit`
 * @param {{ passedTokens: Set<any>, passedThrough: object[] }} passState per-shot state, mutated
 *   (a ShotSystem shot satisfies this)
 * @param {{
 *   stepFor: (collision: object) => ({ blocks: boolean, blockCollision?: object }|null),
 *   carryAt: (distance: number) => (object[]|null)
 * }|null} [wallPlan] optional wall penetration plan; without it every wall stops the walk
 * @param {{ judgeToken?: (collision: object) => ({ pass?: boolean, details?: object }|null) }} [options]
 *   `judgeToken(collision)`: `{ pass: true }` flies past the token; `details` are merged into the
 *   collision's (or the pass record's) details
 * @returns {Array} collisions to record (possibly empty: the projectile flew past everything)
 */
export function walkProjectileCollisions(collisions, onHit, passState, wallPlan = null, { judgeToken = null } = {}) {
  const reached = [];
  const firstOnly = onHit !== 'next';
  for (const collision of collisions) {
    if (collision.type === 'wall') {
      const step = wallPlan?.stepFor?.(collision) ?? null;
      if (step && !step.blocks) continue; // the projectile goes through this wall
      reached.push(step?.blockCollision ?? collision);
      break;
    }
    if (passState.passedTokens.has(collision.object)) continue;
    if (typeof judgeToken === 'function') {
      const verdict = judgeToken(collision) ?? {};
      const details = verdict.details ? { ...collision.details, ...verdict.details } : collision.details;
      if (verdict.pass) {
        passState.passedTokens.add(collision.object);
        passState.passedThrough.push({ object: collision.object, point: collision.point, details });
        continue;
      }
      collision.details = details;
    }
    const carry = wallPlan?.carryAt?.(collision.distance) ?? null;
    if (carry) collision.details = { ...collision.details, carry };
    reached.push(collision);
    if (firstOnly) break;
  }
  return reached;
}

/** Damage of a projectile that is below what an injury can store (hundredths): it is spent. */
export const MIN_CARRY_DAMAGE = 0.005;

/** Total damage of a phased applications package (`[{mode, items: [{damage}]}]`). */
function carriedDamage(applications) {
  let sum = 0;
  for (const phase of Array.isArray(applications) ? applications : []) {
    for (const item of Array.isArray(phase?.items) ? phase.items : []) sum += Math.max(0, Number(item?.damage) || 0);
  }
  return sum;
}

/**
 * Follow a projectile that left a body: what is left of it flies on along the same straight segment and
 * can hurt the next token on its line — and leave that one too.
 *
 * Each hop, in flight order:
 * 1. the walls behind the body are run with the projectile that is left (`planWalls`); a wall that holds
 *    ends the flight;
 * 2. {@link walkProjectileCollisions} (`stop`, the same `judgeToken` as for the first token) picks the next
 *    token the projectile really reaches; the projectile is brought to it by the distance falloff
 *    (`levelAt`) unless the walls have done it already (`details.carry`), and goes in as `details.carry`;
 * 3. `deliver` applies the damage and returns what leaves that body (empty / nothing: it stays in it).
 * The flight ends at a token it did not leave, at a wall it did not get through, when what is left is
 * below {@link MIN_CARRY_DAMAGE}, or at the end of the segment.
 *
 * @param {Object} args
 * @param {Array<{type: string, object?: any, point?: object, distance?: number, details?: object}>} args.collisions
 *   everything behind the body the projectile left, in flight order (the rest of the segment)
 * @param {Array<{mode: string, items: object[]}>} args.exit what left the body (its distance falloff included)
 * @param {number} args.level the falloff level `exit` carries (share of the muzzle energy, 0–1)
 * @param {{ passedTokens: Set<any>, passedThrough: object[] }} args.passState per-shot state, mutated
 * @param {((collision: object) => ({ pass?: boolean, details?: object }|null))|null} [args.judgeToken]
 * @param {(collisions: object[], applications: object[], level: number) => (object|null)} args.planWalls
 *   wall plan (`planWallPasses` result) for the walls among `collisions`; `null` — every wall stops
 * @param {(collision: object) => number} args.levelAt falloff level at a collision (0–1)
 * @param {(applications: object[], ratio: number) => object[]} args.scale energy scaling of a package
 * @param {(collision: object, carry: object[]) => Promise<object[]|null|undefined>} args.deliver
 *   a token was reached with `carry`; resolves to what leaves its body
 * @returns {Promise<{
 *   hits: object[],
 *   wallEvents: object[],
 *   end: { reason: 'spent'|'wall'|'range', collision?: object }
 * }>} `hits` — the collisions reached in order (tokens, the wall that held last); `wallEvents` — the walls
 *   met (see `planWallPasses`); `end` — how the flight ended (`range`: it left the segment)
 */
export async function followProjectileThroughBodies({
  collisions,
  exit,
  level,
  passState,
  judgeToken = null,
  planWalls,
  levelAt,
  scale,
  deliver,
}) {
  const hits = [];
  const wallEvents = [];
  let remaining = Array.isArray(collisions) ? collisions : [];
  let applications = Array.isArray(exit) ? exit : [];
  let currentLevel = Number(level) > 0 ? Number(level) : 1;

  for (;;) {
    if (carriedDamage(applications) < MIN_CARRY_DAMAGE) return { hits, wallEvents, end: { reason: 'spent' } };

    const plan = planWalls?.(remaining, applications, currentLevel) ?? null;
    const [next] = walkProjectileCollisions(remaining, 'stop', passState, plan, { judgeToken });
    // Only the walls the projectile really met: not those behind the token it reaches.
    const limit = next ? next.distance : Infinity;
    if (plan?.events) wallEvents.push(...plan.events.filter((event) => event.entryDistance <= limit + 1e-6));
    if (!next) return { hits, wallEvents, end: { reason: 'range' } };

    hits.push(next);
    if (next.type !== 'token') return { hits, wallEvents, end: { reason: 'wall', collision: next } };

    // What reaches the token: the walls' carry (falloff included), else what left the body, flown on.
    const nextLevel = Number(levelAt(next));
    if (!Array.isArray(next.details?.carry) || !next.details.carry.length) {
      const ratio = currentLevel > 1e-9 && Number.isFinite(nextLevel) ? nextLevel / currentLevel : 1;
      next.details = { ...next.details, carry: scale(applications, ratio) };
    }
    const left = await deliver(next, next.details.carry);

    applications = Array.isArray(left) ? left : [];
    currentLevel = Number.isFinite(nextLevel) && nextLevel > 0 ? nextLevel : currentLevel;
    remaining = remaining.slice(remaining.indexOf(next) + 1);
  }
}
