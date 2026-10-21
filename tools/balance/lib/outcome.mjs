/**
 * Case outcomes for the balance tool: every way a shot of a case can land — over the weapon family of the
 * case and over the hit location (armour gaps, organs) — judged on the game's own outcome scale
 * (`module/helpers/body-state.mjs`), the worst and the best of them, and the verdict against the outcome the
 * owner agreed on.
 *
 * Penetration and damage are deterministic; only where the hit lands is random. So a case's spread comes
 * from (1) the location branches, each with its exact probability (`decide` hook of `resolveBodyTraversal`),
 * and (2) the weapon family: "a pistol does not always penetrate" means different pistols / rounds of the
 * class fall on both sides of the threshold. The cases assume a precise shot: a round lands on an armour
 * plate, not in its gaps; a melee blow looks for the gaps (the live game rolls gaps for every hit).
 */

import { resolveBodyTraversal } from '../../../module/helpers/damage/body-traversal-resolver.mjs';
import { applyBodyState, classifyOutcome, WOUND_OUTCOME_IDS } from '../../../module/helpers/body-state.mjs';
import {
  BLAST_PART_COUNT,
  VOLLEY_SHARED_SPREAD,
  applyEnergyScaleToApplications,
  falloffMultiplier,
  volleySpreadAt,
} from '../../../module/helpers/weapon/damage-profile.mjs';
import {
  ORGAN_NAMES, buildArmorBySlot, buildProjectile, createMaterialResolver, hitDirectionOf, lineCalibers, loadAnatomy, nameBodyParts, snapshot,
} from './engine.mjs';

/** Outcomes rarer than this (per weapon) do not count as the worst or the best of a case. */
export const MIN_OUTCOME_P = 0.02;

/** A volley wider than this at the target (scene units) spreads its pellets over several body parts. */
export const PART_WIDTH = 0.35;

const MAX_BRANCHES = 256;
const MIN_BRANCH_P = 1e-4;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const sev = (id) => WOUND_OUTCOME_IDS.indexOf(id);

/* ------------------------------------------------------------------ *
 *  Weapon family                                                      *
 * ------------------------------------------------------------------ */

/**
 * What a case shoots with. A case with a weapon from the base is that weapon; a case with only a round is
 * the **family**: every weapon of the case's weapon type (the base groups weapons by the same labels) that
 * takes a round of the same caliber group, each round of that group — so variants of a pistol or of a load
 * all count. A melee case (a weapon, no round) uses the row's blow (every blow when it picks none) and strength.
 * @param {object} group case group
 * @param {object} row case row (`lineId`, `effort` for melee)
 * @param {Array<object>} items database items
 * @param {object} dictionaries (`weaponTypes`)
 * @returns {Array<{ label: string, source: object }>}
 */
export function caseMembers(group, row, items, dictionaries) {
  const byId = (id) => items.find((it) => it.id === id);
  const ammo = group.ammoItem ? byId(group.ammoItem) : null;
  const weapon = group.weaponItem ? byId(group.weaponItem) : null;
  if (!ammo && weapon?.kind === 'weapon') {
    // A melee weapon: the row's blow, or every blow of the weapon when the row picks none.
    const effort = num(row?.effort, 100);
    const lines = (weapon.values?.lines ?? []).filter((l) => (l.damage ?? []).length);
    const picked = lines.filter((l) => l.id === row?.lineId);
    return (picked.length ? picked : lines).map((line) => ({
      label: `${weapon.name} · ${line.name}${effort !== 100 ? ` · СИЛ ${effort}` : ''}`,
      source: { kind: 'weapon', itemId: weapon.id, lineId: line.id, effort },
    }));
  }
  if (!ammo) return [];
  if (weapon) return [{ label: `${weapon.name} · ${ammo.name}`, source: { kind: 'ammo', itemId: ammo.id, weaponId: weapon.id } }];
  if (group.family === false) return [{ label: ammo.name, source: { kind: 'ammo', itemId: ammo.id } }];

  const typeLabel = (dictionaries?.weaponTypes ?? []).find((t) => t.id === group.weaponType)?.label;
  const rounds = items.filter((it) => it.kind === 'ammo' && it.group && it.group === ammo.group);
  const weapons = items.filter((it) => it.kind === 'weapon' && typeLabel && it.group === typeLabel);
  const out = [];
  for (const round of rounds.length ? rounds : [ammo]) {
    const caliber = String(round.values?.caliber ?? '').replace(/-s$/i, '');
    const takers = weapons.filter((w) => (w.values?.lines ?? []).some((l) => lineCalibers(l).includes(caliber)));
    if (!takers.length) out.push({ label: round.name, source: { kind: 'ammo', itemId: round.id } });
    for (const w of takers) out.push({ label: `${w.name} · ${round.name}`, source: { kind: 'ammo', itemId: round.id, weaponId: w.id } });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Location branches                                                  *
 * ------------------------------------------------------------------ */

/**
 * Walk every branch of the location rolls of `run(decide)` — each roll goes both ways — with its probability.
 * The tree may change shape with earlier choices; every leaf is visited once.
 * @param {(decide: (event: {chance: number}) => boolean) => any} run
 * @param {{ minBranchP?: number, maxBranches?: number }} [options]
 * @returns {Array<{ p: number, value: any, choices: Array<{kind: string, id: string, chance: number, happened: boolean}> }>}
 */
export function enumerateBranches(run, { minBranchP = MIN_BRANCH_P, maxBranches = MAX_BRANCHES } = {}) {
  const leaves = [];
  const stack = [[]];
  while (stack.length && leaves.length < maxBranches) {
    const prefix = stack.pop();
    const choices = [];
    let p = 1;
    const decide = (event) => {
      const i = choices.length;
      const chance = Math.max(0, Math.min(1, num(event?.chance, 0)));
      const happened = i < prefix.length ? prefix[i] : chance >= 0.5;
      if (i >= prefix.length) {
        const other = p * (happened ? 1 - chance : chance);
        if (other > minBranchP) stack.push([...choices.map((c) => c.happened), !happened]);
      }
      p *= happened ? chance : 1 - chance;
      choices.push({ kind: event?.kind ?? '', id: event?.id ?? '', chance, happened });
      return happened;
    };
    const value = run(decide);
    leaves.push({ p, value, choices });
  }
  return leaves;
}

/* ------------------------------------------------------------------ *
 *  One shot                                                           *
 * ------------------------------------------------------------------ */

/** Parts next to `slot` (its `adjacent` relations, in order) — where a blast on it also lands. */
function neighbours(anatomy, slot) {
  return (anatomy.bodyParts[slot]?.relations ?? []).filter((r) => r?.kind === 'adjacent' && anatomy.bodyParts[r.target]).map((r) => r.target);
}

/** The package of a volley that lands as one wound: every pellet in one parallel phase. */
function volleyPackage(phases, count) {
  const items = phases.flatMap((phase) => phase.items ?? []);
  return [{ mode: 'parallel', items: Array.from({ length: count }, () => items.map((it) => ({ ...it }))).flat() }];
}

/**
 * One shot of the case with given location decisions, judged on the outcome scale.
 * @param {object} args
 * @returns {{ outcome: object, damageBySlot: Record<string, number>, hitDamage: number, maxHp: number, exit: object[], pellets: number|null, note: string }}
 */
export function shotOutcome({ member, row, partId, items, mode = 'values', anatomyId = 'humanoid', decide, partNames = {}, bodyModel }) {
  const anatomy = loadAnatomy(anatomyId);
  nameBodyParts(anatomy, partNames);
  const resolveMaterial = createMaterialResolver(items, mode);
  const projectile = buildProjectile(member.source, items, mode);
  const distance = Math.max(0, num(row?.distance, 0));
  const hitDirection = hitDirectionOf(row?.face);
  const fall = projectile.falloff.enabled ? falloffMultiplier(distance, projectile.falloff) : 1;
  let phases = applyEnergyScaleToApplications(projectile.applications, fall);
  let note = '';

  let armorBySlot = buildArmorBySlot(row?.armor, { items, mode, anatomy, partId, hitDirection });
  const results = [];
  const traverse = (applications, slot, body = anatomy) => {
    const res = resolveBodyTraversal({
      anatomy: body, startSlotRef: slot, hitDirection, applications, armorBySlot: body === anatomy ? armorBySlot : {},
      resolveMaterial, random: () => 0.5, decide, bodyModel,
    });
    if (body === anatomy) {
      armorBySlot = { ...armorBySlot, ...res.armorUpdatesBySlot };
      results.push(res);
    }
    return res;
  };

  // A second target right behind the first: the first (bare, same part) takes the shot, the rest goes on.
  if (row?.target === 'behind') {
    const first = traverse(phases, partId, loadAnatomy(anatomyId));
    phases = first.exitApplications;
    note = phases.length ? 'вышла из первой цели' : 'застряла в первой цели';
  }

  let pellets = null;
  if (phases.length) {
    const ms = projectile.multishot;
    if (ms.enabled && ms.count > 1) {
      const spread = volleySpreadAt(distance, ms.coneDegrees);
      if (spread <= VOLLEY_SHARED_SPREAD) {
        pellets = ms.count;
        traverse(volleyPackage(phases, ms.count), partId);
        note = note || `${ms.count} дробин одной раной`;
      } else {
        pellets = Math.max(1, Math.min(ms.count, Math.round(ms.count * Math.min(1, PART_WIDTH / spread))));
        for (let i = 0; i < pellets; i += 1) traverse(phases, partId);
        note = note || `${pellets} из ${ms.count} дробин в часть, отдельными ранами`;
      }
    } else {
      traverse(phases, partId);
    }
    // A blast on contact (`onHitSplash`): it reaches the hit part and its neighbours, the energy split.
    const splash = projectile.onHitSplash;
    if (splash.enabled && !splash.excludeDirectHit) {
      const parts = [partId, ...neighbours(anatomy, partId)].slice(0, BLAST_PART_COUNT);
      const share = applyEnergyScaleToApplications(phases, 1 / parts.length);
      for (const slot of parts) traverse(share, slot);
      note = [note, `взрыв: ${parts.length} части`].filter(Boolean).join(', ');
    }
  }

  // Wounds → the state of the body → the outcome.
  const wounds = [];
  const damageBySlot = {};
  const organHits = [];
  for (const res of results) {
    for (const [slot, hits] of Object.entries(res.bodyDamageBySlot)) {
      const amount = hits.reduce((s, h) => s + h.amount, 0);
      if (!(amount > 0)) continue;
      const dominant = hits.reduce((a, h) => (h.amount > (a?.amount ?? 0) ? h : a), null);
      const inners = (res.innerHitsBySlot[slot] ?? []).map((h) => ({ id: h.innerId, amount: h.amount }));
      wounds.push({ slotRef: slot, amount, initialAmount: amount, type: dominant?.type ?? 'ballistic', inners });
      damageBySlot[slot] = (damageBySlot[slot] ?? 0) + amount;
      for (const h of inners) organHits.push({ slot, id: h.id });
    }
  }
  const state = applyBodyState(anatomy.bodyParts, wounds, { rootRef: anatomy.root });
  const outcome = classifyOutcome({ bodyParts: anatomy.bodyParts, ...state }, { hitSlot: partId, damageBySlot, organHits });
  return {
    outcome,
    damageBySlot,
    hitDamage: damageBySlot[partId] ?? 0,
    maxHp: num(anatomy.bodyParts[partId]?.effectiveMaxHp, 0),
    exit: snapshot(results.at(-1)?.exitApplications ?? []),
    pellets,
    note,
  };
}

/* ------------------------------------------------------------------ *
 *  A case row                                                         *
 * ------------------------------------------------------------------ */

/**
 * Agreed vs computed: `match` — both ends agree; `near` — the computed range lies inside the agreed one and
 * one end agrees (a non-critical deviation); `miss` — otherwise; `none` — no agreed outcome yet. A destroyed
 * part that killed counts as both "destroyed" and "death".
 * @param {string|null} expectedWorst outcome id
 * @param {string|null} expectedBest outcome id (empty = the same as the worst)
 * @param {{id: string, fatal?: boolean}} worst
 * @param {{id: string, fatal?: boolean}} best
 * @returns {'match'|'near'|'miss'|'none'}
 */
export function verdict(expectedWorst, expectedBest, worst, best) {
  if (!expectedWorst || !worst || !best) return 'none';
  const ew = sev(expectedWorst);
  const eb = sev(expectedBest || expectedWorst);
  const level = (o, expected) => {
    const s = sev(o.id);
    if (o.id === 'destroyed' && o.fatal && (expected === sev('death') || expected === sev('destroyed'))) return expected;
    return s;
  };
  const w = level(worst, ew);
  const b = level(best, eb);
  if (w === ew && b === eb) return 'match';
  if (w <= ew && b >= eb && (w === ew || b === eb)) return 'near';
  return 'miss';
}

/**
 * Every outcome a case row can have, the worst and the best (outcomes rarer than {@link MIN_OUTCOME_P} per
 * weapon do not count) and the verdict.
 * @param {object} group
 * @param {object} row
 * @param {{ items: object[], dictionaries: object }} db
 * @param {{ valuesMode?: 'values'|'base' }} [options]
 */
export function evaluateCase(group, row, { items, dictionaries }, { valuesMode = 'values', bodyModel } = {}) {
  const part = (dictionaries.parts ?? []).find((p) => p.id === group.part);
  if (!part?.slot) return { ok: false, error: 'skip' };
  const members = caseMembers(group, row, items, dictionaries);
  if (!members.length) return { ok: false, error: 'skip' };

  const partNames = Object.fromEntries((dictionaries.parts ?? []).filter((p) => p.slot).map((p) => [p.slot, p.label ?? p.id]));
  const organNames = ORGAN_NAMES;
  const perMember = members.map((member) => {
    // A precise shot (what the cases assume) lands on the plate; a blade looks for the gap in it.
    const ranged = member.source.kind === 'ammo';
    const branches = enumerateBranches((decide) => shotOutcome({
      member, row, partId: part.slot, items, mode: valuesMode, partNames, bodyModel,
      decide: ranged ? (event) => (event.kind === 'gap' ? false : decide(event)) : decide,
    }));
    const dist = {};
    for (const b of branches) dist[b.value.outcome.id] = (dist[b.value.outcome.id] ?? 0) + b.p;
    return { member, branches, dist };
  });

  // Outcomes per weapon: the branches that end the same way add up; the most likely one shows where it landed.
  const candidates = [];
  for (const { member, branches } of perMember) {
    const byOutcome = new Map();
    for (const b of branches) {
      const key = `${b.value.outcome.id}${b.value.outcome.fatal ? '*' : ''}`;
      const entry = byOutcome.get(key) ?? { p: 0, top: b };
      entry.p += b.p;
      if (b.p > entry.top.p) entry.top = b;
      byOutcome.set(key, entry);
    }
    for (const { p, top } of byOutcome.values()) {
      candidates.push({ ...top.value.outcome, p, member: member.label, note: top.value.note, location: describeChoices(top.choices, organNames) });
    }
  }
  const counted = candidates.filter((o) => o.p >= MIN_OUTCOME_P);
  const pool = counted.length ? counted : candidates.slice().sort((x, y) => y.p - x.p).slice(0, 1);
  const worst = pool.reduce((a, o) => (!a || o.severity > a.severity || (o.severity === a.severity && o.p > a.p) ? o : a), null);
  const best = pool.reduce((a, o) => (!a || o.severity < a.severity || (o.severity === a.severity && o.p > a.p) ? o : a), null);
  const main = perMember[0].branches.slice().sort((x, y) => y.p - x.p)[0]?.value;
  return {
    ok: true,
    worst,
    best,
    status: verdict(row.worst, row.best, worst, best),
    members: perMember.map(({ member, dist }) => ({ label: member.label, dist })),
    total: main?.hitDamage ?? 0,
    maxHp: main?.maxHp ?? 0,
    ratio: main?.maxHp > 0 ? main.hitDamage / main.maxHp : null,
    stopped: (main?.hitDamage ?? 0) <= 0,
  };
}

/**
 * Every case row: its outcomes and verdict (rows without a round or weapon from the base are skipped).
 * @param {{ groups: object[], rows: object[], dictionaries: object, items: object[], extra?: { valuesMode?: string } }} args
 * @returns {Array<object>} `{ rowId, ok, error? , ...evaluateCase }`
 */
export function checkCases({ groups, rows, dictionaries, items, extra = {} }) {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  return rows.map((row) => {
    const group = groupById.get(row.groupId);
    if (!group) return { rowId: row.id, ok: false, error: 'skip' };
    try {
      return { rowId: row.id, ...evaluateCase(group, row, { items, dictionaries }, { valuesMode: extra.valuesMode, bodyModel: extra.bodyModel }) };
    } catch (e) {
      return { rowId: row.id, ok: false, error: String(e.message ?? e) };
    }
  });
}


/** `в щель брони, задеты: мозг` — where a branch landed, in words (only rolls that could go either way). */
function describeChoices(choices, organNames = ORGAN_NAMES) {
  const open = choices.filter((c) => c.chance > 0 && c.chance < 1);
  const words = [];
  for (const c of open.filter((x) => x.kind === 'gap')) words.push(c.happened ? 'в щель брони' : 'в пластину');
  const organs = open.filter((x) => x.kind === 'organ');
  const hit = organs.filter((x) => x.happened).map((x) => organNames[x.id] ?? x.id);
  if (hit.length) words.push(`задеты: ${hit.join(', ')}`);
  else if (organs.length) words.push('органы мимо');
  return words.join(', ');
}
