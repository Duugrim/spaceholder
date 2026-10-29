/**
 * View model of the penetration view: turns the penetration track of a shot (`penetration-track.mjs`, the rays of
 * the shot merged by `penetration-shot.mjs`) and the shot entry it belongs to (`weapon/attack-log.mjs`) into what
 * the templates draw — a block per wall or body part with a row per layer, the verdict, the geometry of the
 * energy stream that runs down the rows (one stream, or a lane for each projectile of the block), and the texts
 * of the preview pane: what happened to the projectile at a layer ("9x19 pierces Kevlar 1 mm, energy 46 (92%) →
 * 6 (12%)") with the numbers behind it, the facts of every hit and of the shot.
 *
 * Pure (no Foundry globals); the strings come through an injected localizer so the texts can be tested
 * (`node module/helpers/damage/penetration-view-model.test.mjs`).
 */

import { getDamageType } from './damage-types.mjs';
import { MAX_LANES, energyPercent, groupTokenKey, primaryItem, trackStreams } from './penetration-track.mjs';
import { mergeShot } from './penetration-shot.mjs';
import { foundryLocalizer } from '../i18n-localizer.mjs';
import { buildHitsInfo, buildShotInfo } from '../weapon/shot-info.mjs';

export { foundryLocalizer };

const I18N = 'SPACEHOLDER.PenetrationView';

/** The narrowest a stream may be drawn while it still carries energy (percent of the stream column). */
const FLOW_MIN_PCT = 4;

const ICONS = Object.freeze({
  wall: 'fa-grip-lines',
  body: 'fa-user',
  armor: 'fa-shield-halved',
  tissue: 'fa-heart-pulse',
  pass: 'fa-angles-down',
  hold: 'fa-hand',
  skip: 'fa-ellipsis',
});

/** A number for a line of text: hundredths at most, no trailing zeros; `?` when it is not a number. */
export function formatValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  return String(Math.round(n * 100) / 100);
}

/**
 * Width of the energy stream for an amount of energy: percent of the stream column (of its slot, when there are
 * lanes), the muzzle energy being the full width. An amount that is above zero is never thinner than
 * {@link FLOW_MIN_PCT}.
 * @param {unknown} value
 * @param {number|null} reference muzzle energy
 * @returns {number} 0–100
 */
export function flowWidth(value, reference) {
  const v = Number(value);
  const ref = Number(reference);
  if (!Number.isFinite(v) || v <= 0 || !(ref > 0)) return 0;
  return Math.max(FLOW_MIN_PCT, Math.min(100, Math.round((v / ref) * 1000) / 10));
}

/** Half of the stream's full width, in percent of its column: 100 (the muzzle energy) is 80% wide, so it never touches the edges. */
const FLOW_HALF_PCT = 0.4;

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * The outline of the stream of a row, drawn in a 100×100 box stretched over the row: a shape as wide as the
 * energy entering the row (`w0`) at the top and as the energy leaving it (`w1`) at the bottom, and the two
 * side edges (the top and the bottom are not stroked: the next row continues the stream). One lane per
 * projectile: the column is cut into as many slots, each lane is drawn in its own.
 * @param {Array<{ w0: number, w1: number }|null>} lanes widths (0–100) of every lane; `null`: the lane is not here
 * @returns {{ shape: string, edges: string }} `d` of the filled shapes, `d` of the stroked edges
 */
export function lanesFlowGeometry(lanes) {
  const n = Math.max(1, lanes.length);
  const slot = 100 / n;
  const shape = [];
  const edges = [];
  lanes.forEach((lane, i) => {
    if (!lane || !(lane.w0 > 0 || lane.w1 > 0)) return;
    const center = (i + 0.5) * slot;
    const l0 = r1(center - lane.w0 * 0.01 * FLOW_HALF_PCT * slot);
    const r0 = r1(center + lane.w0 * 0.01 * FLOW_HALF_PCT * slot);
    const l1 = r1(center - lane.w1 * 0.01 * FLOW_HALF_PCT * slot);
    const r1x = r1(center + lane.w1 * 0.01 * FLOW_HALF_PCT * slot);
    shape.push(`M ${l0} 0 L ${r0} 0 L ${r1x} 100 L ${l1} 100 Z`);
    edges.push(`M ${l0} 0 L ${l1} 100 M ${r0} 0 L ${r1x} 100`);
  });
  return { shape: shape.join(' '), edges: edges.join(' ') };
}

/** The outline of one stream (a block of one projectile). @see lanesFlowGeometry */
export function flowGeometry(w0, w1) {
  return lanesFlowGeometry([{ w0, w1 }]);
}

/**
 * Width (px) of the energy column for a block of that many lanes: a lane keeps room to be seen.
 * @param {number} lanes
 * @param {{ base?: number, perLane?: number, max?: number }} [size] defaults are the window's; the cards over the tokens are narrower
 */
export function streamWidth(lanes, { base = 64, perLane = 14, max = 160 } = {}) {
  return Math.round(Math.min(max, Math.max(base, perLane * Math.max(1, Number(lanes) || 1))));
}

const laneOf = (item) => (Number.isInteger(item?.lane) ? item.lane : 0);
const itemsOfLane = (stage, lane) => (stage.items ?? []).filter((item) => laneOf(item) === lane);
const sum = (list) => list.reduce((total, value) => total + value, 0);

/**
 * Build the model.
 *
 * The groups of the view are the things a shot met: a wall, or a target (one token, however many parts of its body
 * were hit — they are its `parts`). The energy column has a lane for each projectile (stream) and runs down all the
 * groups: every stream starts at the muzzle at the top, runs straight down its lane and meets the parts that are its
 * own; the streams are numbered in the order the groups meet them, and the first stream is the rightmost lane — so
 * the list reads from the right lane to the left, and the lanes of one target go down to its different parts.
 *
 * @param {object|null} track the penetration track to show — one ray's, or the merged track of a shot
 *   (`mergeShot`: it says its streams); `null`: the projectile went through nothing
 * @param {{ t: Function, f: Function }} [i18n] localizer (defaults to `game.i18n`)
 * @param {Object} [context]
 * @param {object|null} [context.entry] the shot entry of the attack log: the arc, the spread, the AP
 * @param {object[][]} [context.impacts] the hits of every block of the track (`mergeShot().impacts`)
 * @param {string} [context.projectile] name of the projectile when the track has none
 * @returns {object}
 */
export function buildPenetrationView(track, i18n = foundryLocalizer(), { entry = null, impacts = [], projectile: fallbackName = '' } = {}) {
  const { t, f } = i18n;
  const energy = Number(track?.energy) > 0 ? Number(track.energy) : null;
  const projectile = String(track?.projectile ?? '').trim() || String(fallbackName ?? '').trim() || t(`${I18N}.Projectile`, 'Projectile');
  const typeLabel = (type) => {
    const label = getDamageType(type)?.label;
    return (label && t(label, '')) || type || '';
  };
  const withPct = (value) => {
    const p = energyPercent(value, energy);
    return p === null ? formatValue(value) : `${formatValue(value)} (${p}%)`;
  };
  const ctx = { projectile, energy, withPct, typeLabel, t, f };

  let index = 0;
  const trackGroups = track?.groups ?? [];
  const { streams, blockStreams } = trackStreams(track);
  const slotCount = Math.min(streams.length, MAX_LANES);
  const slotOfStream = (k) => (Number.isInteger(k) && k >= 0 && k < slotCount ? slotCount - 1 - k : -1);
  const widthOf = (value) => (energy !== null && value !== null && value !== undefined ? flowWidth(value, energy) : 0);
  // The last block each lane has to do with: after it the lane is over.
  const lastGroup = Array.from({ length: slotCount }, () => -1);
  trackGroups.forEach((_group, g) => {
    for (const k of blockStreams[g] ?? []) {
      const s = slotOfStream(k);
      if (s >= 0) lastGroup[s] = g;
    }
  });
  // What each stream carries on (absolute energy), and whether its energy is already written in the column.
  const carried = Array.from({ length: slotCount }, () => energy);
  const printed = Array.from({ length: slotCount }, () => false);
  const slots = Array.from({ length: slotCount }, (_, s) => s);
  const listOf = (flags) => flags.map((on, s) => (on ? s : -1)).filter((s) => s >= 0).join(' ');
  // How many lanes of the column a row needs: up to the last one that is drawn in it. The lanes end from the right, so
  // the rows below them are given the room back — the column narrows and the row's text moves left.
  const usedOf = (lanes) => (energy === null ? slotCount : lanes.reduce((used, lane, s) => (lane ? s + 1 : used), 0));
  const outline = (lanes) => {
    const used = usedOf(lanes);
    const geometry = energy !== null && used ? lanesFlowGeometry(lanes.slice(0, used)) : null;
    return geometry && (geometry.shape || geometry.edges) ? geometry : null;
  };
  const flowOf = (lanes, folded = null) => {
    const geometry = outline(lanes);
    if (!geometry) return null;
    return {
      w0: Math.max(...lanes.map((lane) => lane?.w0 ?? 0)),
      w1: Math.max(...lanes.map((lane) => lane?.w1 ?? 0)),
      ...geometry,
      folded,
      valueIn: '',
      valueOut: '',
    };
  };

  /** One part of a body (or a wall) the shot met: its layers, and how every lane goes through them. */
  const buildBlock = (group, g) => {
    const laneCount = Number(group.lanes) > 1 ? Number(group.lanes) : 1;
    const stagesIn = group.stages ?? [];
    // The lane of the block → the lane of the column.
    const blockSlots = Array.from({ length: laneCount }, (_, l) => slotOfStream((blockStreams[g] ?? [])[l]));
    const parallel = g === 0 || group.parallel === true || laneCount > 1;
    const itemsOf = (stage, slot) => {
      const l = blockSlots.indexOf(slot);
      return l < 0 ? [] : itemsOfLane(stage, l);
    };
    const firstE = slots.map((s) => {
      for (const stage of stagesIn) {
        const first = primaryItem({ items: itemsOf(stage, s) });
        if (first && Number.isFinite(Number(first.eIn))) return Number(first.eIn);
      }
      return null;
    });
    const endStage = slots.map((s) => stagesIn.reduce((last, stage, i) => (itemsOf(stage, s).length ? i : last), -1));
    // Lanes the block is about.
    const present = slots.map((s) => blockSlots.includes(s));
    const alive = slots.map((s) => lastGroup[s] >= g);
    const cur = carried.slice();
    const before = cur.slice();
    const aliveAtStart = alive.slice();
    const widthsText = () => slots.map((s) => (alive[s] ? widthOf(cur[s]) : 0)).join(' ');
    const straight = (s) => {
      const w = widthOf(before[s]);
      return aliveAtStart[s] && w > 0 ? { w0: w, w1: w } : null;
    };

    // The head: from where the stream was (the muzzle, or where the block before left it) to the first layer.
    const taperLanes = slots.map((s) => {
      if (!aliveAtStart[s] || energy === null) return null;
      return present[s] ? { w0: widthOf(before[s]), w1: widthOf(firstE[s] ?? cur[s]) } : straight(s);
    });
    const plainLanes = slots.map((s) => straight(s));
    const headWidths = widthsText();
    const heldHere = new Set();

    // The piece of gear (armour, clothes) a layer belongs to: layers of one piece that follow each other are a run
    // — its name is written above the first of them and a bracket runs along them.
    const pieceAt = (si) => String(stagesIn[si]?.source ?? '').trim();

    const stages = stagesIn.map((stage, si) => {
      const piece = pieceAt(si);
      const taking = []; // lanes with an item at this layer
      const rows = slots.map((s) => {
        const items = itemsOf(stage, s);
        const primary = primaryItem({ items });
        if (!primary) {
          // A layer the lane took no part in (a gap, a bypass) lets it through as it is; so does a block that is
          // none of its business, until its way is over.
          const over = lastGroup[s] === g && si > endStage[s];
          return alive[s] && !over && energy !== null && cur[s] !== null && cur[s] !== undefined
            ? { w0: widthOf(cur[s]), w1: widthOf(cur[s]), eIn: cur[s], eOut: cur[s], plain: true }
            : null;
        }
        taking.push(s);
        const eIn = Number(primary.eIn);
        const eOut = primary.verdict === 'hold' ? 0 : Number(primary.eOut);
        const known = Number.isFinite(eIn) && energy !== null;
        return {
          w0: known ? widthOf(eIn) : 0,
          w1: known ? (stage.verdict === 'skip' ? widthOf(eIn) : widthOf(eOut)) : 0,
          eIn,
          eOut,
          verdict: primary.verdict,
          plain: false,
        };
      });

      const stops = taking.filter((s) => rows[s].verdict === 'hold');
      const rowLanes = rows.map((row) => (row ? { w0: row.w0, w1: row.w1 } : null));
      const geometry = rows.some((row) => row) ? outline(rowLanes) : null;

      // The lanes after the layer: held ones are gone, the rest carry what left it.
      rows.forEach((row, s) => {
        if (!row) return;
        if (row.verdict === 'hold') {
          alive[s] = false;
          cur[s] = 0;
          heldHere.add(s);
          lastGroup[s] = Math.min(lastGroup[s], g);
        } else if (!row.plain && Number.isFinite(row.eOut) && stage.verdict !== 'skip') {
          cur[s] = row.eOut;
        }
      });

      let flow = null;
      if (geometry) {
        const live = slots.filter((s) => rows[s] && !rows[s].plain && Number.isFinite(rows[s].eIn));
        // The first layer of a block: its entry is written unless it is what the lane left the block before with
        // (then that number is already there, at the lower edge of the row before).
        const showIn = si === 0 && live.some((s) => !printed[s] || Math.abs((before[s] ?? 0) - rows[s].eIn) > 0.005);
        flow = {
          w0: Math.max(...rows.map((row) => row?.w0 ?? 0)),
          w1: Math.max(...rows.map((row) => row?.w1 ?? 0)),
          ...geometry,
          valueIn: showIn ? formatValue(sum(live.map((s) => rows[s].eIn))) : '',
          // What the lanes of the block that are on their way carry out of the layer (a held one carries nothing).
          valueOut: stage.verdict === 'skip' || !live.length ? '' : formatValue(sum(slots.filter((s) => rows[s] && present[s]).map((s) => cur[s] ?? 0))),
        };
      }

      // A layer nobody took part in (a gap, a bypass) is all the same gone by the lanes of the block that are still on
      // their way: the animation lets them visit it, so it does not light up only when everything else is over.
      const visiting = taking.length ? taking : slots.filter((s) => present[s] && rows[s]?.plain);
      const passing = taking.filter((s) => rows[s].verdict !== 'hold').length;
      const model = {
        key: `s${index}`,
        index,
        kind: stage.kind,
        side: stage.side ?? '',
        icon: ICONS[stage.kind] ?? ICONS.armor,
        verdict: stage.verdict,
        verdictIcon: ICONS[stage.verdict] ?? ICONS.skip,
        verdictLabel: verdictLabel(stage, t, f, taking.length > 1 && passing > 0 && passing < taking.length ? { pass: passing, total: taking.length } : null),
        name: stage.name || t(`${I18N}.Layer.${stage.kind}`, stage.kind),
        // The piece the layer belongs to: its run (a bracket along the layers) and, on the first layer, its name.
        inPiece: piece !== '',
        pieceStart: piece !== '' && piece !== pieceAt(si - 1),
        pieceEnd: piece !== '' && piece !== pieceAt(si + 1),
        pieceName: piece !== '' && piece !== pieceAt(si - 1) ? piece : '',
        // Tissue has no thickness of its own: the one on its stage is the shell (e.g. the skull).
        thicknessLabel: stage.thickness && stage.kind !== 'tissue' ? f(`${I18N}.Thickness`, { value: formatValue(stage.thickness) }, `${formatValue(stage.thickness)} mm`) : '',
        // The numbers of the energy column sit on the boundaries between rows: what leaves every layer, and what
        // enters the first layer of a block when that is not what left the layer before (the head of the block is
        // between them) — so the column reads X → Y → Z, a value twice only where something was lost between.
        // Several lanes in a block: the sum of what they carry.
        flow,
        // For the animation: the lanes that meet this layer, the ones it holds, the energy of every lane after it.
        used: usedOf(rowLanes),
        here: visiting.join(' '),
        stops: stops.join(' '),
        widths: widthsText(),
        detail: buildStageDetail(stage, { ...ctx, layer: layerLabel(stage, t, f), lanes: taking.map((s) => blockSlots.indexOf(s)).sort((a, b) => a - b), laneCount }),
      };
      index += 1;
      return model;
    });

    // The layers of one piece keep their text where the widest of them has it (the rows below a lane that ended do not
    // step left), so the bracket along them is straight.
    for (let i = 0; i < stages.length;) {
      let end = i;
      while (stages[end].inPiece && !stages[end].pieceEnd && end + 1 < stages.length) end += 1;
      const widest = Math.max(...stages.slice(i, end + 1).map((s) => s.used));
      for (let k = i; k <= end; k += 1) stages[k].pieceUsed = stages[k].inPiece ? widest : stages[k].used;
      i = end + 1;
    }

    // Folded to its head, the lanes narrow to what they carry out of the block.
    const foldedLanes = slots.map((s) => {
      if (!aliveAtStart[s] || energy === null) return null;
      return present[s] ? { w0: widthOf(before[s]), w1: widthOf(cur[s]) } : straight(s);
    });

    slots.forEach((s) => {
      carried[s] = cur[s];
      if (present[s] && endStage[s] >= 0) printed[s] = true;
    });

    const hits = impacts[g] ?? [];
    const info = group.kind === 'wall' ? [] : buildHitsInfo(hits, i18n);
    return {
      g,
      hits,
      present,
      plainLanes,
      foldedLanes,
      heldHere,
      model: {
        key: `p${g}`,
        partName: group.kind === 'wall' ? '' : (group.subtitle ?? ''),
        ...groupChipFields(group, t, f),
        // How many projectiles the part is about.
        lanes: laneCount,
        lanesLabel: laneCount > 1 ? f(`${I18N}.Group.Lanes`, { count: String(laneCount) }, `×${laneCount}`) : '',
        lanesTip: laneCount > 1 ? f(`${I18N}.Group.LanesTip`, { count: String(laneCount) }, `Projectiles: ${laneCount}`) : '',
        pending: group.pending === true,
        pendingLabel: group.pending ? t(`${I18N}.Pending`, 'Damage awaits the GM') : '',
        flow: flowOf(taperLanes),
        used: usedOf(taperLanes),
        here: listOf(present),
        widths: headWidths,
        stopsFolded: [...heldHere].sort((a, b) => a - b).join(' '),
        info,
        parallel,
        stages,
      },
    };
  };

  const blocks = trackGroups.map(buildBlock);

  // The things the shot met: a wall each; the parts of one target together.
  const things = [];
  blocks.forEach((block) => {
    const key = groupTokenKey(trackGroups[block.g]);
    const last = things[things.length - 1];
    if (key && last?.key === key) last.blocks.push(block);
    else things.push({ key, blocks: [block] });
  });

  const groups = things.map(({ blocks: own }, i) => {
    const [first] = own;
    const raw = trackGroups[first.g];
    const multi = own.length > 1;
    const parts = own.map((block) => block.model);
    const stages = parts.flatMap((part) => part.stages);
    const wall = raw.kind === 'wall';
    const hits = [...new Set(own.flatMap((block) => block.hits))];
    const info = wall ? [] : buildHitsInfo(hits, i18n);
    const summary = info.find((row) => row.key === 'Damage') ?? info.find((row) => row.key === 'Status') ?? null;
    const lanes = new Set(own.flatMap((block) => blockStreams[block.g] ?? [])).size || 1;
    const names = [...new Set(parts.map((part) => part.partName).filter(Boolean))];

    // The head of a target: the lanes go by it (straight) when there are several parts they go down to, else it is
    // the head of its only part (they narrow to its first layer). Folded, they narrow to what they carry out.
    const heldHere = new Set(own.flatMap((block) => [...block.heldHere]));
    const foldedLanes = slots.map((s) => own.find((block) => block.present[s])?.foldedLanes[s] ?? first.foldedLanes[s]);
    const flow = multi ? flowOf(first.plainLanes, flowOf(foldedLanes)) : (first.model.flow ? { ...first.model.flow, folded: flowOf(foldedLanes) } : null);
    const hasStages = stages.length > 0;
    const title = wall ? t(`${I18N}.Group.Wall`, 'Wall') : (raw.title || t(`${I18N}.Group.Body`, 'Target'));
    // What the preview of a part says about whom it is.
    for (const part of parts) Object.assign(part, { multi, title, img: raw.img ?? '', icon: wall ? ICONS.wall : ICONS.body });
    return {
      key: `g${i}`,
      kind: wall ? 'wall' : 'body',
      icon: wall ? ICONS.wall : ICONS.body,
      img: raw.img ?? '',
      title,
      subtitle: names.join(', '),
      tokenId: raw.tokenId ?? '',
      at: raw.at ?? null,
      multi,
      // Hit quality and the share of the energy: on the head when there is one part, else on each part.
      chip: multi ? '' : first.model.chip,
      chipQuality: multi ? '' : first.model.chipQuality,
      chipScale: multi ? '' : first.model.chipScale,
      // How many projectiles the target took, and how many lanes the column has beside it.
      lanes,
      slots: slotCount,
      parallel: first.model.parallel,
      lanesLabel: lanes > 1 ? f(`${I18N}.Group.Lanes`, { count: String(lanes) }, `×${lanes}`) : '',
      lanesTip: lanes > 1 ? f(`${I18N}.Group.LanesTip`, { count: String(lanes) }, `Projectiles: ${lanes}`) : '',
      streamWidth: streamWidth(slotCount),
      pending: parts.some((part) => part.pending),
      pendingLabel: parts.some((part) => part.pending) ? t(`${I18N}.Pending`, 'Damage awaits the GM') : '',
      flow,
      used: multi ? usedOf(first.plainLanes) : first.model.used,
      here: listOf(slots.map((s) => own.some((block) => block.present[s]))),
      stopsFolded: [...heldHere].sort((a, b) => a - b).join(' '),
      widths: first.model.widths,
      info,
      summary: summary ? summary.value : '',
      summaryTone: summary?.tone ?? '',
      foldable: hasStages,
      foldLabel: t(`${I18N}.FoldGroup`, 'Fold or unfold the layers'),
      collapsed: false,
      parts,
      stages,
    };
  });

  const shot = buildShotInfo(entry, i18n);
  return {
    shotId: track?.shotId ?? '',
    title: f(`${I18N}.Title`, { projectile }, `Penetration: ${projectile}`),
    projectile,
    shotLabel: entry && Number(entry.n) > 0 ? f(`${I18N}.ShotN`, { n: String(entry.n) }, `Shot ${entry.n}`) : '',
    energy: energy === null ? '' : formatValue(energy),
    energyLabel: energy === null ? '' : f(`${I18N}.MuzzleEnergy`, { value: formatValue(energy) }, `Energy ${formatValue(energy)}`),
    groups,
    empty: !groups.length,
    emptyLabel: t(`${I18N}.Empty`, 'The projectile met nothing'),
    shot: { title: t(`${I18N}.Shot.Title`, 'Shot'), rows: shot.rows, passes: shot.passes, passesLabel: t(`${I18N}.Shot.Passes`, 'Flew past') },
    stageCount: index,
    streamWidth: streamWidth(slotCount),
    lanes: slotCount,
    foldable: groups.some((group) => group.foldable),
    folded: groups.some((group) => group.collapsed),
    foldLabel: t(`${I18N}.Fold`, 'Fold all'),
    unfoldLabel: t(`${I18N}.Unfold`, 'Unfold all'),
  };
}

/**
 * The view of a whole shot: every ray of the entry merged into blocks (`mergeShot`), the hits of each block
 * and the facts of the shot.
 * @param {object} entry ShotEntry of the attack log
 * @param {{ t: Function, f: Function }} [i18n]
 * @param {{ projectile?: string }} [options]
 */
export function buildShotView(entry, i18n = foundryLocalizer(), { projectile = '' } = {}) {
  const merged = mergeShot({ entry });
  return buildPenetrationView(merged.track, i18n, { entry, impacts: merged.impacts, projectile });
}

/** `Kevlar 1 mm` — the layer as the preview names it (a body part is just its name). */
function layerLabel(stage, t, f) {
  const name = stage.name || t(`${I18N}.Layer.${stage.kind}`, stage.kind);
  if (stage.kind === 'tissue' || !stage.thickness) return name;
  const thickness = f(`${I18N}.Thickness`, { value: formatValue(stage.thickness) }, `${formatValue(stage.thickness)} mm`);
  return `${name} ${thickness}`;
}

function verdictLabel(stage, t, f, mixed) {
  if (stage.verdict === 'skip') {
    return stage.skip === 'gap' ? t(`${I18N}.Verdict.Gap`, 'Gap') : t(`${I18N}.Verdict.Skip`, 'Missed');
  }
  if (mixed) return f(`${I18N}.Verdict.Lanes`, { pass: String(mixed.pass), total: String(mixed.total) }, `${mixed.pass}/${mixed.total}`);
  if (stage.kind === 'tissue') {
    return stage.verdict === 'pass' ? t(`${I18N}.Verdict.Through`, 'Through') : t(`${I18N}.Verdict.Lodged`, 'Lodged');
  }
  return stage.verdict === 'pass' ? t(`${I18N}.Verdict.Pass`, 'Pierced') : t(`${I18N}.Verdict.Hold`, 'Stopped');
}

/**
 * How much of the projectile's energy reached a body, when less than all of it: the whole label ("glancing ×0.6"),
 * and its two parts — how the hit was (glancing…) and the share of the energy ("×0.69"). The cards over the tokens
 * have room for the second only.
 */
function groupChipFields(group, t, f) {
  const scale = Number(group.scale);
  if (!Number.isFinite(scale) || scale >= 1) return { chip: '', chipQuality: '', chipScale: '' };
  const value = formatValue(scale);
  const quality = String(group.quality ?? '').trim();
  const chipScale = f(`${I18N}.Scale`, { value }, `×${value}`);
  return {
    chip: quality ? f(`${I18N}.ScaleQuality`, { quality, value }, `${quality} ×${value}`) : chipScale,
    chipQuality: quality,
    chipScale,
  };
}

/**
 * The preview of a layer: a headline that says what happened to the projectile ("pierces Kevlar 1 mm, energy
 * 46 (92%) → 6 (12%)", "Kevlar 3 mm stops 9x19, energy 30 (60%) → 0") and the rows behind it — the armour piece,
 * the resistance, the damage by type "before → after", the other types, the loss before the layer, wear, the
 * blow handed on, the damage the tissue took, the organs hit. Several projectiles at the layer: how many got
 * through, a row for each, the damage of all of them together.
 *
 * @returns {{ headline: string, source: string, rows: Array<{ label: string, value: string }> }}
 */
function buildStageDetail(stage, { projectile, layer, energy, withPct, typeLabel, t, f, lanes, laneCount }) {
  const many = lanes.length > 1;
  const primary = primaryItem(many ? { items: stage.items ?? [] } : stage) ?? {};
  const data = {
    projectile,
    layer,
    before: formatValue(primary.eIn),
    after: formatValue(primary.eOut),
    beforePct: String(energyPercent(primary.eIn, energy) ?? ''),
    afterPct: String(energyPercent(primary.eOut, energy) ?? ''),
    coverage: formatValue(stage.notes?.coverage),
  };
  const known = energy !== null && Number.isFinite(Number(primary.eIn));
  const pickKey = (name) => `${I18N}.Tip.${name}${known ? '' : 'Plain'}`;

  let headline;
  const held = many ? lanes.filter((l) => itemsOfLane(stage, l).every((item) => item.verdict === 'hold')).length : 0;
  const passed = many ? lanes.length - held : 0;
  if (stage.verdict === 'skip') {
    headline = stage.skip === 'gap'
      ? f(`${I18N}.Tip.Gap`, data, `${projectile}: ${layer}`)
      : f(`${I18N}.Tip.Skip`, data, `${projectile}: ${layer}`);
  } else if (stage.kind === 'wall' && stage.notes?.reason === 'opaque') {
    headline = f(`${I18N}.Tip.WallOpaque`, data, `${layer}`);
  } else if (stage.kind === 'wall' && stage.notes?.reason === 'unbounded') {
    headline = f(`${I18N}.Tip.WallUnbounded`, data, `${layer}`);
  } else if (many) {
    const name = held === 0 ? 'LanesPass' : (passed === 0 ? 'LanesHold' : 'LanesMixed');
    headline = f(`${I18N}.Tip.${name}`, { ...data, pass: String(passed), hold: String(held), total: String(lanes.length) }, `${layer}: ${passed}/${lanes.length}`);
  } else if (stage.kind === 'tissue') {
    const name = stage.verdict === 'pass' ? 'TissuePass' : (stage.notes?.inShell ? 'TissueShell' : 'TissueHold');
    headline = f(pickKey(name), data, `${projectile}: ${layer}`);
  } else {
    headline = f(pickKey(stage.verdict === 'pass' ? 'Pass' : 'Hold'), data, `${projectile}: ${layer}`);
  }

  const rows = [];
  const row = (key, value, fallback) => rows.push({ label: t(`${I18N}.Row.${key}`, fallback), value: String(value) });
  if (many) {
    for (const l of lanes) {
      const lead = primaryItem({ items: itemsOfLane(stage, l) });
      if (!lead || !Number.isFinite(Number(lead.eIn))) continue;
      const out = lead.verdict === 'hold' ? 0 : lead.eOut;
      rows.push({ label: f(`${I18N}.Row.Lane`, { n: String(l + 1) }, `Projectile ${l + 1}`), value: `${withPct(lead.eIn)} → ${lead.verdict === 'hold' ? '0' : withPct(out)}` });
    }
  } else if (Number.isFinite(Number(primary.eIn))) {
    row('Energy', `${withPct(primary.eIn)} → ${withPct(primary.eOut)}`, 'Energy');
  }
  if (stage.resist) row('Resist', formatValue(stage.resist), 'Layer resistance');
  if (!many && stage.verdict === 'hold' && stage.resist > Number(primary.eIn)) {
    row('Short', formatValue(stage.resist - Number(primary.eIn)), 'Energy short by');
  }
  if (many) {
    // The damage of all of them together, by type.
    const byType = new Map();
    for (const item of stage.items ?? []) {
      if (item.dIn === null && item.dOut === null) continue;
      const total = byType.get(item.type) ?? { dIn: 0, dOut: 0 };
      total.dIn += Number(item.dIn) || 0;
      total.dOut += Number(item.dOut) || 0;
      byType.set(item.type, total);
    }
    for (const [type, total] of byType) {
      rows.push({ label: f(`${I18N}.Row.Damage`, { type: typeLabel(type) }, `Damage (${typeLabel(type)})`), value: `${formatValue(total.dIn)} → ${formatValue(total.dOut)}` });
    }
  } else {
    for (const item of stage.items ?? []) {
      if (item.dIn === null && item.dOut === null) continue;
      rows.push({ label: f(`${I18N}.Row.Damage`, { type: typeLabel(item.type) }, `Damage (${typeLabel(item.type)})`), value: `${formatValue(item.dIn)} → ${formatValue(item.dOut)}` });
    }
    for (const item of (stage.items ?? []).filter((candidate) => candidate !== primary && candidate.eIn !== null)) {
      rows.push({ label: f(`${I18N}.Row.OtherType`, { type: typeLabel(item.type) }, typeLabel(item.type)), value: `${withPct(item.eIn)} → ${withPct(item.eOut)}` });
    }
  }
  if (stage.lostBefore && laneCount === 1) row('Lost', formatValue(stage.lostBefore), 'Lost before the layer');
  const notes = stage.notes ?? {};
  if (notes.wear) row('Wear', f(`${I18N}.Row.WearValue`, { wear: formatValue(notes.wear), integrity: formatValue(notes.integrity) }, `${formatValue(notes.wear)}`), 'Layer wear');
  if (notes.conduct?.length) row('Conduct', notes.conduct.map((c) => `${typeLabel(c.type)} ${formatValue(c.amount)}`).join(', '), 'Hands on a blow');
  if (notes.deposit) row('Deposit', formatValue(notes.deposit), 'Tissue takes damage');
  if (notes.organs?.length) row('Organs', notes.organs.join(', '), 'Organs hit');
  return { headline, source: stage.source ?? '', rows };
}
