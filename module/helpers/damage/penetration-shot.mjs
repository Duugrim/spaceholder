/**
 * Penetration shot — all the results of one shot (one pull of the trigger) as one record. A shot of several
 * projectiles (the pellets of a volley, a blast) is several rays with a penetration track each
 * (`penetration-track.mjs`); the view of the shot is not a list of rays but a list of what they met:
 *
 * - a **block** is a wall or a body part of a target (the target and the part: two pellets in one shoulder are
 *   one block, one in the shoulder and one in the chest are two); what the rays that met it saw goes into it. The
 *   blocks of one target stand together in the list (the view makes one group of them: the target, and the parts
 *   its streams go down to);
 * - a **lane** is one projectile in a block (its ray; the pellets of a wound the volley made together are lanes
 *   too, their items are told apart by their `lane`); the layers (the stages) of a block are common to its lanes,
 *   each lane's items say what it did at the layer.
 *
 * - a **stream** is a projectile's way through the whole shot: a ray, or — for a blast, which reaches every
 *   target at once — a target's share of the blast. The streams of a shot all start at the muzzle and run side by
 *   side; the window draws one lane for each of them down the whole list of blocks. They are numbered in the
 *   order the list meets them: the first stream is the one whose records come first.
 *
 * The result is a track in the format of `penetration-track.mjs` (groups with `lanes` / `rays`, items with
 * `lane`; `streams` of the track and of its groups: which streams meet each block) — plus, next to it, the hits of
 * every block, so the view can tell the facts of the hits. A shot of one
 * ray comes out as that ray's track. A hit that went through no layer worth a record (no damage to apply, a
 * blast that left nothing on a body) is a block without stages (`bare`): the view lists it, the overlay and
 * the sanitizer of a track do not.
 *
 * Pure (no Foundry globals): `node module/helpers/damage/penetration-shot.test.mjs`.
 */

import { MAX_LANES, entryRays, groupTokenKey } from './penetration-track.mjs';
import { isHitImpact } from '../weapon/attack-log.mjs';

const EPS = 1e-9;
/** Shares of the projectile's energy that reached a target closer than this are one share. */
const SCALE_TOLERANCE = 0.01;
const MAX_NOTES = 6;

function num(value) {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function stageSignature(stage) {
  return [stage.kind, stage.side ?? '', stage.name ?? '', stage.thickness ?? '', stage.source ?? ''].join('|');
}

function groupKey(group) {
  if (group.kind === 'wall') {
    return `wall|${(group.stages ?? []).map((s) => `${s.name ?? ''}:${s.thickness ?? ''}`).join('+')}`;
  }
  return `body|${group.tokenId || group.title || ''}|${group.subtitle ?? ''}`;
}

/**
 * The lanes a group of a ray is made of: one for a plain group, one per pellet for the wound of a volley (the
 * items of its stages are sorted by their `lane`). A pellet's stages are those it took part in.
 */
function laneSlices(group, rayId) {
  if (!(group.lanes > 1) || !Array.isArray(group.rays)) return [{ ray: rayId, stages: group.stages ?? [], lane: null }];
  // The notes of a layer belong to the wound, not to a pellet: the first lane that took part in the layer keeps them.
  const noted = new Set();
  const out = [];
  for (let l = 0; l < group.lanes; l += 1) {
    const stages = [];
    (group.stages ?? []).forEach((stage, i) => {
      const items = (stage.items ?? []).filter((item) => item.lane === l);
      // A layer nobody touched (a gap in the coverage) is the wound's, so it is every pellet's.
      if (!items.length && (stage.items ?? []).length) return;
      const copy = { ...stage, items };
      if (noted.has(i)) delete copy.notes;
      noted.add(i);
      stages.push(copy);
    });
    out.push({ ray: group.rays[l] ?? `${rayId}#${l}`, stages, lane: l });
  }
  return out;
}

/** Notes of the stages of one layer, seen by several lanes, as one. */
function mergeNotes(into, notes) {
  if (!notes) return;
  if (notes.wear) into.wear = round2((into.wear ?? 0) + notes.wear);
  if (notes.integrity !== undefined) into.integrity = into.integrity === undefined ? notes.integrity : Math.min(into.integrity, notes.integrity);
  if (notes.deposit) into.deposit = round2((into.deposit ?? 0) + notes.deposit);
  if (notes.conduct?.length) into.conduct = [...(into.conduct ?? []), ...notes.conduct].slice(0, MAX_NOTES);
  if (notes.organs?.length) into.organs = [...new Set([...(into.organs ?? []), ...notes.organs])].slice(0, MAX_NOTES);
  for (const flag of ['reachedOrgans', 'inShell']) if (notes[flag]) into[flag] = true;
  for (const key of ['mode', 'coverage', 'reason']) if (notes[key] !== undefined && into[key] === undefined) into[key] = notes[key];
}

/** Verdict of a layer seen by several lanes: someone got through, else someone was held, else nobody took part. */
function stageVerdict(items) {
  if (items.some((item) => item.verdict === 'pass')) return 'pass';
  if (items.some((item) => item.verdict === 'hold')) return 'hold';
  return 'skip';
}

/**
 * The layers of the lanes of a block as one list: the layers are matched by what they are (kind, side, name,
 * thickness, the armour piece); a layer a lane has and the others have not goes where it stood in that lane.
 * @param {Array<{ lane: number, stages: object[] }>} lanes lane index (in the block) and its stages
 * @param {boolean} labelled whether the items are labelled with their lane (more than one lane)
 */
function mergeLaneStages(lanes, labelled) {
  const skeleton = [];
  for (const { lane, stages } of lanes) {
    let cursor = -1;
    for (const stage of stages) {
      const sig = stageSignature(stage);
      let at = skeleton.findIndex((entry, i) => i > cursor && entry.sig === sig);
      if (at < 0) {
        at = cursor + 1;
        skeleton.splice(at, 0, { sig, first: stage, items: [], notes: {}, resist: 0, lostBefore: 0 });
      }
      const entry = skeleton[at];
      for (const item of stage.items ?? []) {
        const { lane: _drop, ...rest } = item;
        entry.items.push(labelled ? { ...rest, lane } : rest);
      }
      mergeNotes(entry.notes, stage.notes);
      entry.resist = Math.max(entry.resist, stage.resist ?? 0);
      entry.lostBefore = Math.max(entry.lostBefore, stage.lostBefore ?? 0);
      cursor = at;
    }
  }
  return skeleton.map((entry) => {
    const { items: _items, notes: _notes, resist: _resist, lostBefore: _lost, verdict: _verdict, skip: _skip, ...base } = entry.first;
    const stage = { ...base, items: entry.items, verdict: entry.items.length ? stageVerdict(entry.items) : 'skip' };
    if (entry.first.skip && !entry.items.length) stage.skip = entry.first.skip;
    if (entry.resist > 0) stage.resist = entry.resist;
    if (entry.lostBefore > 0) stage.lostBefore = entry.lostBefore;
    if (Object.keys(entry.notes).length) stage.notes = entry.notes;
    return stage;
  });
}

/**
 * What one ray puts into the blocks: its groups in flight order (each cut into lane slices), and the hits that
 * have no group (a bare block) placed where the ray met them.
 * @returns {Array<{ at: number, key: string, seed: object, slice: object, impacts: object[] }>}
 */
function placeRay(ray, all) {
  const own = all.filter((impact) => !impact?.shotId || impact.shotId === ray.id);
  const groups = ray.track?.groups ?? [];
  const used = new Set();
  const seen = new Map();
  const joinedOf = new Map();
  const consumed = new Set();

  /** The impact of another pellet of the wound `impact` is the leader of: the first of its ray that joined it. */
  const joinedImpact = (impact, rayId) => {
    const key = `${rayId}|${all.indexOf(impact)}`;
    if (joinedOf.has(key)) return joinedOf.get(key);
    const found = all.find((candidate) => candidate?.shotId === rayId && candidate.joined && !consumed.has(candidate)
      && (candidate.tokenUuid === impact.tokenUuid || candidate.name === impact.name)) ?? null;
    if (found) consumed.add(found);
    joinedOf.set(key, found);
    return found;
  };

  const sequence = [];
  groups.forEach((group, g) => {
    const impact = Number.isInteger(group.hit) ? own[group.hit] ?? null : null;
    if (impact) used.add(group.hit);
    const base = groupKey(group);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    // A blast reaches every target at once: each target (part) is a stream of its own, not the next leg of one.
    const stream = group.parallel === true ? `${ray.id}#${g}` : ray.id;
    for (const slice of laneSlices(group, stream)) {
      const pellets = [];
      if (impact) {
        if (slice.lane === null || slice.lane === 0) pellets.push(impact);
        else {
          const joined = joinedImpact(impact, slice.ray);
          if (joined) pellets.push(joined);
        }
      }
      sequence.push({
        at: g,
        key: `${base}#${n}`,
        seed: group,
        slice: { ...slice, parallel: g === 0 || group.parallel === true, group },
        impacts: pellets,
      });
    }
  });

  // The hits no group tells of (no damage to apply, a hit with nothing on the body): a block of their own, put
  // before the first group of a later hit — and before the walls in front of that one.
  const bare = [];
  own.forEach((impact, i) => {
    if (used.has(i) || !isHitImpact(impact) || impact.joined) return;
    let at = groups.findIndex((group) => Number.isInteger(group.hit) && group.hit > i);
    if (at < 0) at = groups.length;
    while (at > 0 && !Number.isInteger(groups[at - 1].hit)) at -= 1;
    bare.push({
      at: at - 0.5,
      key: `bare|${impact.tokenUuid || impact.name || ''}|${impact.partName ?? ''}`,
      seed: { kind: 'body', title: String(impact.name ?? ''), subtitle: String(impact.partName ?? ''), tokenId: impact.tokenId, stages: [], bare: true },
      slice: { ray: ray.id, stages: [], lane: null, parallel: true, group: null },
      impacts: [impact],
    });
  });
  return [...sequence, ...bare].sort((a, b) => a.at - b.at);
}

/**
 * The blocks with the blocks of one target together: in the order each target (or wall) first appears, the target's
 * blocks in the order they appeared in. Walls stay as they are.
 */
function orderByToken(blocks) {
  const buckets = new Map();
  blocks.forEach((block, i) => {
    const key = groupTokenKey(block.seed) ?? `own|${i}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(block);
  });
  return [...buckets.values()].flat();
}

/**
 * Merge the rays of a shot.
 *
 * @param {Object} args
 * @param {object|null} [args.entry] the shot entry of the attack log (`ids`, `tracks`, `impacts`)
 * @param {Array<{ id: string, track: object|null }>} [args.rays] the rays in hand (instead of the entry's)
 * @param {object[]} [args.impacts] the impacts of the shot (instead of the entry's)
 * @param {string[]} [args.rayIds] only these rays of the entry
 * @returns {{ track: object|null, impacts: object[][], rays: string[] }} `track` the merged track (`null` when the
 *   shot has neither a layer nor a hit to show); its `streams` are the streams of the shot in the order the blocks
 *   meet them (ids: the ray, `<ray>#<n>` for a part of a blast) and `groups[i].streams` the ones that meet block
 *   `i`, in the order of its lanes; `impacts[i]` the hits of `track.groups[i]`; `rays` the ids of all the rays
 */
export function mergeShot({ entry = null, rays = null, impacts = null, rayIds = null } = {}) {
  let list = rays ?? (entry ? entryRays(entry) : []);
  if (Array.isArray(rayIds)) list = list.filter((ray) => rayIds.includes(ray.id));
  const all = Array.isArray(impacts) ? impacts : (Array.isArray(entry?.impacts) ? entry.impacts : []);

  const blocks = new Map();
  for (const ray of list) {
    for (const placed of placeRay(ray, all)) {
      let block = blocks.get(placed.key);
      if (!block) {
        block = { seed: placed.seed, slices: [], impacts: [] };
        blocks.set(placed.key, block);
      }
      block.slices.push(placed.slice);
      for (const impact of placed.impacts) if (!block.impacts.includes(impact)) block.impacts.push(impact);
    }
  }

  const groups = [];
  const blockImpacts = [];
  const streams = [];
  for (const block of orderByToken([...blocks.values()])) {
    const rayIdsOfBlock = [];
    for (const slice of block.slices) {
      if (!rayIdsOfBlock.includes(slice.ray) && rayIdsOfBlock.length < MAX_LANES) rayIdsOfBlock.push(slice.ray);
    }
    // The streams are numbered as the blocks meet them, so the lanes of a shared block stand side by side.
    const blockStreams = rayIdsOfBlock.map((id) => {
      const k = streams.indexOf(id);
      return k >= 0 ? k : streams.push(id) - 1;
    });
    const labelled = rayIdsOfBlock.length > 1;
    const stages = mergeLaneStages(rayIdsOfBlock.map((ray, lane) => ({
      lane,
      stages: block.slices.filter((slice) => slice.ray === ray).flatMap((slice) => slice.stages),
    })), labelled);

    const seed = block.seed;
    const scales = block.slices.map((slice) => num(slice.group?.scale)).filter((v) => v !== null);
    const scale = scales.length && scales.every((v) => Math.abs(v - scales[0]) <= SCALE_TOLERANCE) ? scales[0] : undefined;
    const quality = block.slices.map((slice) => slice.group?.quality).find(Boolean);
    // Lanes carry no energy from one block to the next: each starts with what its first layer took in.
    const parallel = labelled || block.slices.some((slice) => slice.parallel);
    groups.push({
      kind: seed.kind === 'wall' ? 'wall' : 'body',
      ...(seed.title ? { title: seed.title } : {}),
      ...(seed.subtitle ? { subtitle: seed.subtitle } : {}),
      ...(seed.img ? { img: seed.img } : {}),
      ...(seed.tokenId ? { tokenId: seed.tokenId } : {}),
      ...(seed.at ? { at: seed.at } : {}),
      ...(scale !== undefined && Math.abs(scale - 1) > EPS ? { scale } : {}),
      ...(quality ? { quality } : {}),
      ...(!stages.length && block.slices.some((slice) => slice.group?.pending) ? { pending: true } : {}),
      ...(parallel ? { parallel: true } : {}),
      ...(labelled ? { lanes: rayIdsOfBlock.length, rays: rayIdsOfBlock } : {}),
      streams: blockStreams,
      ...(seed.bare ? { bare: true } : {}),
      stages,
    });
    blockImpacts.push(block.impacts);
  }

  const withTrack = list.map((ray) => ray.track).filter(Boolean);
  const energy = withTrack.map((track) => num(track.energy)).find((v) => v !== null && v > EPS);
  const projectile = withTrack.map((track) => track.projectile).find(Boolean) ?? '';
  const ids = list.map((ray) => ray.id);
  if (!groups.length) return { track: null, impacts: [], rays: ids };
  return {
    track: {
      v: 1,
      shotId: ids[0] ?? '',
      ...(projectile ? { projectile } : {}),
      ...(energy !== undefined ? { energy } : {}),
      streams,
      groups,
    },
    impacts: blockImpacts,
    rays: ids,
  };
}
