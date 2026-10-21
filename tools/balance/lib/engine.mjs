/**
 * Shot simulator for the balance calculator.
 *
 * It runs the game's own pure modules (`module/helpers/damage/*`, `weapon/damage-profile.mjs`,
 * `walls/wall-penetration.mjs`) on database items, so the numbers are what the current mechanics give —
 * only the inputs (materials, ammo, armour) come from the balance database instead of Foundry documents.
 *
 * Pipeline of one shot, mirroring the live one:
 *   ammo damage entries (+ weapon energy multiplier)  ->  applications with precomputed energy
 *   -> for every element on the line, in order of distance:
 *        distance falloff (energy; damage follows)  ->  wall (`passSpan`)  |  target (hit quality,
 *        `resolveBodyTraversal`: armour, tissue deposit, organs, what leaves the body)
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_DIR } from './compendium.mjs';

import {
  activeDamageEntries,
  damageEntriesToApplications,
  falloffMultiplier,
  normalizeDamageEntries,
  normalizeFalloff,
  normalizeMultishot,
  normalizeOnHitSplash,
  applyEnergyScaleToApplications,
  resolveEntriesEffort,
} from '../../../module/helpers/weapon/damage-profile.mjs';
import { applyDamageModifiers } from '../../../module/helpers/weapon/weapon-model.mjs';
import { normalizeApplications } from '../../../module/helpers/damage/damage-resolver.mjs';
import { resolveBodyTraversal } from '../../../module/helpers/damage/body-traversal-resolver.mjs';
import { normalizeMaterial } from '../../../module/helpers/damage/materials-manager.mjs';
import { isUsableWallMaterial, passSpan } from '../../../module/helpers/walls/wall-penetration.mjs';
import { resolveIncomingFace } from '../../../module/helpers/anatomy-groups.mjs';
import { applyBodyState, classifyOutcome } from '../../../module/helpers/body-state.mjs';

const ANATOMY_DIR = path.join(REPO_DIR, 'data', 'anatomy');
const MAX_SHOTS = 50;
const EPS = 1e-9;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

/* ------------------------------------------------------------------ *
 *  Inputs                                                             *
 * ------------------------------------------------------------------ */

/** Russian names of the organs the presets use (the presets carry English names). */
export const ORGAN_NAMES = Object.freeze({
  brain: 'мозг', eyes: 'глаза', ears: 'уши', heart: 'сердце', lungs: 'лёгкие', guts: 'кишечник', liver: 'печень', stomach: 'желудок', kidneys: 'почки',
  artery: 'артерия',
});

/**
 * Put the tool's labels on an anatomy copy (for the outcome reasons): the case dictionary's part labels and
 * Russian organ names.
 * @param {object} anatomy a copy from {@link loadAnatomy} — mutated
 * @param {Record<string, string>} [partNames] slot → label
 */
export function nameBodyParts(anatomy, partNames = {}) {
  for (const [slot, label] of Object.entries(partNames)) if (anatomy.bodyParts[slot]) anatomy.bodyParts[slot].name = label;
  for (const part of Object.values(anatomy.bodyParts)) for (const inner of part.inners ?? []) inner.name = ORGAN_NAMES[inner.id] ?? inner.name;
  return anatomy;
}

const anatomyText = new Map();

/**
 * A fresh, mutable copy of an anatomy preset (the file is read once per file change).
 * @param {string} id anatomy preset id (file in `data/anatomy/`)
 */
export function loadAnatomy(id = 'humanoid') {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  const file = path.join(ANATOMY_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) throw new Error(`Unknown anatomy "${id}"`);
  const mtime = fs.statSync(file).mtimeMs;
  const cached = anatomyText.get(file);
  if (!cached || cached.mtime !== mtime) anatomyText.set(file, { mtime, text: fs.readFileSync(file, 'utf8') });
  return JSON.parse(anatomyText.get(file).text);
}

/**
 * Resolver direction for a case/calculator side: `front`, `back` or `side` (a hit from the left or
 * right, symmetric). The anatomy presets only have front and back faces, so the resolver treats a side
 * hit like a hit on the part's first face — the same fallback the game has for any unknown direction.
 * @param {string} face
 * @returns {'front'|'back'|'left'}
 */
export function hitDirectionOf(face) {
  if (face === 'back') return 'back';
  if (face === 'side' || face === 'left' || face === 'right') return 'left';
  return 'front';
}

const FACE_LABEL = Object.freeze({ front: 'спереди', left: 'сбоку', back: 'сзади' });

/** Which snapshot of an item the simulation reads. */
function valuesOf(item, mode) {
  return mode === 'base' && item.base ? item.base : item.values;
}

/**
 * @param {Array<object>} items database items
 * @param {'values'|'base'} mode
 * @returns {(materialId: string) => object}
 */
export function createMaterialResolver(items, mode = 'values') {
  const cache = new Map();
  const bySlug = new Map();
  for (const item of items) {
    if (item.kind === 'material') bySlug.set(item.id.replace(/^material\./, ''), item);
  }
  return (materialId) => {
    const slug = String(materialId ?? '');
    if (cache.has(slug)) return cache.get(slug);
    const item = bySlug.get(slug);
    const out = item
      ? normalizeMaterial({ ...valuesOf(item, mode), materialId: slug, name: item.name })
      : normalizeMaterial({ materialId: slug }); // unknown slug: empty material, transparent to the resolver
    cache.set(slug, out);
    return out;
  };
}

function findItem(items, id, kind) {
  const item = items.find((it) => it.id === id && (!kind || it.kind === kind));
  if (!item) throw new Error(`Item "${id}" not found in the database`);
  return item;
}

/**
 * Calibers a weapon line takes. Some lines store them as one comma-separated string.
 * @param {object} line
 * @returns {string[]}
 */
export function lineCalibers(line) {
  return (line?.calibers ?? []).flatMap((c) => String(c ?? '').split(',')).map((c) => c.trim().replace(/-s$/i, '')).filter(Boolean);
}

/**
 * The projectile a request fires: damage entries, falloff and the phased applications.
 * @param {object} source `{ kind: 'ammo'|'weapon', itemId, weaponId?, lineId?, effort? }`
 * @param {Array<object>} items
 * @param {'values'|'base'} mode
 */
export function buildProjectile(source, items, mode = 'values') {
  const kind = source?.kind === 'weapon' ? 'weapon' : 'ammo';
  const effort = num(source?.effort, 100);
  let entries;
  let falloff = { enabled: false, halfDistance: 0 };
  let multishot = normalizeMultishot(null);
  let onHitSplash = normalizeOnHitSplash(null);
  let name;
  let energyMult = null;

  if (kind === 'ammo') {
    const ammo = findItem(items, source.itemId, 'ammo');
    const v = valuesOf(ammo, mode);
    entries = activeDamageEntries(v.damage);
    falloff = normalizeFalloff(v.falloff);
    multishot = normalizeMultishot(v.multishot);
    onHitSplash = normalizeOnHitSplash(v.onHitSplash);
    name = ammo.name;
    if (source.weaponId) {
      const weapon = findItem(items, source.weaponId, 'weapon');
      const lines = valuesOf(weapon, mode).lines ?? [];
      const caliber = String(v.caliber ?? '').replace(/-s$/i, '');
      const line = lines.find((l) => l.id === source.lineId)
        ?? lines.find((l) => lineCalibers(l).includes(caliber))
        ?? lines[0];
      if (line?.energyMult?.enabled) energyMult = line.energyMult;
      name = `${weapon.name} · ${ammo.name}`;
    }
  } else {
    const weapon = findItem(items, source.itemId, 'weapon');
    const lines = valuesOf(weapon, mode).lines ?? [];
    const line = lines.find((l) => l.id === source.lineId) ?? lines.find((l) => (l.damage ?? []).length) ?? lines[0];
    if (!line) throw new Error(`Weapon "${weapon.name}" has no attack line`);
    entries = resolveEntriesEffort(activeDamageEntries(line.damage), effort);
    energyMult = line.energyMult?.enabled ? line.energyMult : null;
    name = `${weapon.name} · ${line.name}`;
  }

  if (!entries.length) throw new Error('The source has no damage entries');
  entries = applyDamageModifiers(entries, [], energyMult);
  const applications = damageEntriesToApplications(entries);
  return { name, entries: normalizeDamageEntries(entries), falloff, multishot, onHitSplash, applications, energyMult };
}

/* ------------------------------------------------------------------ *
 *  Snapshots and scaling                                              *
 * ------------------------------------------------------------------ */

/** Flat, display-ready view of phased applications. */
export function snapshot(phases) {
  const out = [];
  for (const phase of normalizeApplications(phases)) {
    for (const it of phase.items) {
      const energy = Number.isFinite(it.energy) ? it.energy : it.damage * it.armorPen * it.armorPen * it.hardness;
      out.push({
        type: it.type,
        damage: it.damage,
        armorPen: it.armorPen * 100,
        hardness: it.hardness,
        energy,
        reduction: Number.isFinite(it.armorDamageReduction) ? it.armorDamageReduction : 100,
      });
    }
  }
  return out;
}

/**
 * Distance falloff between two points of the flight: the energy scales by `ratio` (the falloff at the far
 * point over the falloff at the near one), the damage follows it, the armour penetration stays — the
 * same `applyEnergyScaleToApplications` the live attack uses. A carried energy (after a wall) is scaled.
 */
export function scaleByFalloff(phases, ratio) {
  return applyEnergyScaleToApplications(phases, Math.max(0, num(ratio, 1)));
}

/* ------------------------------------------------------------------ *
 *  Armour                                                             *
 * ------------------------------------------------------------------ */

function cleanLayers(layers) {
  return (Array.isArray(layers) ? layers : [])
    .map((l) => {
      const out = { material: String(l?.material ?? '').trim(), thickness: Math.max(0, num(l?.thickness, 0)) };
      // A plate with gaps (`coverage` < 100, percent): the traversal rolls whether the hit lands on it.
      const coverage = num(l?.coverage, 100);
      if (coverage < 100) out.coverage = Math.max(0, coverage);
      return out;
    })
    .filter((l) => l.material && l.thickness > 0);
}

/**
 * Layers a case/calculator armour spec stands for.
 * @param {{ kind?: string, presetId?: string, layers?: object[] }|null|undefined} spec
 * @param {Array<object>} items
 * @param {'values'|'base'} mode
 */
export function armorLayersOf(spec, items, mode = 'values') {
  if (!spec || spec.kind === 'none' || !spec.kind) return [];
  if (spec.kind === 'layers') return cleanLayers(spec.layers);
  if (spec.kind === 'preset') return cleanLayers(valuesOf(findItem(items, spec.presetId, 'preset'), mode).layers);
  return [];
}

/**
 * `armorBySlot` for the resolver.
 *  - `none` / `preset` / `layers`: one coverage on the hit part's incoming face;
 *  - `item`: a wearable from the database with all of its covered parts.
 */
export function buildArmorBySlot(spec, { items, mode, anatomy, partId, hitDirection }) {
  if (!spec || !spec.kind || spec.kind === 'none') return {};
  if (spec.kind === 'item') {
    const item = findItem(items, spec.itemId, 'armor');
    const out = {};
    (valuesOf(item, mode).coveredParts ?? []).forEach((cover, idx) => {
      const layers = cleanLayers(cover.layers);
      const slot = String(cover.slotRef ?? '');
      if (!slot || !layers.length || !anatomy.bodyParts[slot]) return;
      (out[slot] ??= []).push({ itemId: item.id, coverageIdx: idx, face: cover.face ?? '', layers });
    });
    return out;
  }
  const layers = armorLayersOf(spec, items, mode);
  if (!layers.length) return {};
  const face = resolveIncomingFace(anatomy.bodyParts[partId], hitDirection);
  return { [partId]: [{ itemId: 'balance-armor', coverageIdx: 0, face, layers }] };
}

/* ------------------------------------------------------------------ *
 *  Simulation                                                         *
 * ------------------------------------------------------------------ */

function compactTrace(trace) {
  return (trace ?? []).map((t) => ({
    slotRef: t.slotRef ?? '',
    phase: t.phase ?? '',
    kind: t.kind,
    material: t.material ?? '',
    type: t.type ?? '',
    incoming: t.incoming ?? null,
    eAR: t.eAR ?? null,
    energyBefore: t.energyBefore ?? null,
    energyAfter: t.energyAfter ?? null,
    residual: t.residual ?? null,
    integrityAfter: t.integrityAfter ?? null,
  }));
}

function sumAmounts(hits) {
  return (hits ?? []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
}

/** Display name of a body part: the request's own label for the slot, else the anatomy's name. */
function partLabel(part, id, names = {}) {
  return names[id] ?? part?.name ?? id;
}

/**
 * @typedef {Object} SimRequest
 * @property {'values'|'base'} [valuesMode]
 * @property {{ kind: 'ammo'|'weapon', itemId: string, weaponId?: string, lineId?: string, effort?: number }} source
 * @property {boolean} [falloff=true]
 * @property {number} [random=0.5] value every resolver roll gets
 * @property {Array<object>} elements walls `{ type:'wall', distance, material, thickness }` and one target
 *   `{ type:'target', distance, partId, hitDirection, armor, energyScale, shots, anatomyId, partHp }`
 */

/**
 * @param {SimRequest} request
 * @param {Array<object>} items database items
 * @returns {object}
 */
export function simulate(request, items) {
  const mode = request?.valuesMode === 'base' ? 'base' : 'values';
  const resolveMaterial = createMaterialResolver(items, mode);
  const random = () => Math.min(0.999999, Math.max(0, num(request?.random, 0.5)));
  const warnings = [];

  const projectile = buildProjectile(request.source, items, mode);
  const useFalloff = request.falloff !== false && projectile.falloff.enabled;
  const elements = (Array.isArray(request.elements) ? request.elements : [])
    .map((el, i) => ({ ...el, _i: i }))
    .sort((a, b) => num(a.distance) - num(b.distance) || a._i - b._i);

  const steps = [{
    kind: 'start',
    label: projectile.name,
    distance: 0,
    out: snapshot(projectile.applications),
    falloff: projectile.falloff,
  }];

  let phases = projectile.applications;
  let prevDistance = 0;
  let target = null;

  for (const el of elements) {
    const distance = Math.max(0, num(el.distance));
    const ratio = useFalloff
      ? falloffMultiplier(distance, projectile.falloff) / Math.max(EPS, falloffMultiplier(prevDistance, projectile.falloff))
      : 1;
    phases = scaleByFalloff(phases, ratio);
    prevDistance = distance;
    const incoming = snapshot(phases);

    if (el.type === 'wall') {
      const thickness = Math.max(0, num(el.thickness));
      const material = resolveMaterial(el.material);
      if (!isUsableWallMaterial(material)) warnings.push(`Стена «${el.material}»: материал не найден — считается пустым.`);
      const pass = passSpan({ span: { material: el.material, thickness }, applications: phases, resolveMaterial, random });
      steps.push({
        kind: 'wall',
        label: `${material.name || el.material} ${thickness} мм`,
        distance,
        falloffRatio: ratio,
        in: incoming,
        out: pass.penetrated ? snapshot(pass.applications) : [],
        penetrated: pass.penetrated,
        trace: compactTrace(pass.trace),
      });
      if (!pass.penetrated) {
        steps.push({ kind: 'stopped', label: 'Снаряд остановлен', distance, in: [], out: [] });
        break;
      }
      phases = pass.applications;
      continue;
    }

    if (el.type === 'target') {
      target = runTarget({ el, phases, incoming, ratio, distance, items, mode, resolveMaterial, random, steps, names: request.partNames ?? {} });
      break;
    }
  }

  return { ok: true, valuesMode: mode, projectile: { name: projectile.name, entries: projectile.entries, falloff: projectile.falloff, energyMult: projectile.energyMult, useFalloff }, steps, target, warnings };
}

function runTarget({ el, phases, incoming, ratio, distance, items, mode, resolveMaterial, random, steps, names }) {
  const anatomy = loadAnatomy(el.anatomyId || 'humanoid');
  const partId = String(el.partId ?? '');
  const part = anatomy.bodyParts[partId];
  if (!part) throw new Error(`Part "${partId}" not found in anatomy "${anatomy.id}"`);
  const hitDirection = hitDirectionOf(el.hitDirection);
  const energyScale = Math.max(0, Math.min(1, num(el.energyScale, 1)));
  const shots = Math.max(1, Math.min(MAX_SHOTS, Math.floor(num(el.shots, 1))));
  const hpOverride = num(el.partHp, 0);

  const scaled = applyEnergyScaleToApplications(phases, energyScale);
  steps.push({
    kind: 'target',
    label: `${partLabel(part, partId, names)} (${FACE_LABEL[hitDirection]})`,
    distance,
    falloffRatio: ratio,
    energyScale,
    in: incoming,
    out: snapshot(scaled),
  });

  let armorBySlot = buildArmorBySlot(el.armor, { items, mode, anatomy, partId, hitDirection });
  const perShot = [];
  // The body keeps its wounds over a series: the state after each hit is judged on the outcome scale.
  const wounds = [];
  const damageBySlot = {};
  const organHits = [];
  for (let n = 1; n <= shots; n += 1) {
    const res = resolveBodyTraversal({
      anatomy, startSlotRef: partId, hitDirection, applications: scaled, armorBySlot, resolveMaterial, random,
    });
    const parts = Object.entries(res.bodyDamageBySlot).map(([slot, hits]) => {
      const p = anatomy.bodyParts[slot];
      const maxHp = slot === partId && hpOverride > 0 ? hpOverride : num(p?.maxHp, 0);
      const total = sumAmounts(hits);
      return {
        slot,
        name: partLabel(p, slot, names),
        total,
        byType: hits.map((h) => ({ type: h.type, amount: h.amount })),
        maxHp,
        ratio: maxHp > 0 ? total / maxHp : null,
      };
    });
    const entry = parts.find((p) => p.slot === partId) ?? { slot: partId, name: partLabel(part, partId, names), total: 0, byType: [], maxHp: hpOverride > 0 ? hpOverride : num(part.maxHp, 0), ratio: 0 };
    const wound = res.woundsBySlot?.[partId] ?? null;
    const organs = Object.entries(res.innerHitsBySlot ?? {}).flatMap(([slot, hits]) => (hits ?? []).map((h) => {
      const inner = (anatomy.bodyParts[slot]?.inners ?? []).find((o) => o.id === h.innerId);
      return { slot, id: h.innerId, name: inner?.name ?? h.innerId, amount: h.amount, maxHp: num(inner?.maxHp, 0), vital: (inner?.tags ?? []).includes('vital') };
    }));
    const armorLayers = (res.armorUpdatesBySlot[partId] ?? []).flatMap((s) => s.layers.map((l) => ({
      material: l.material, thickness: l.thickness, integrity: l.integrity, integrityMax: l.integrityMax,
    })));
    for (const p of parts) {
      if (!(p.total > 0)) continue;
      const dominant = p.byType.reduce((a, h) => (h.amount > (a?.amount ?? 0) ? h : a), null);
      const inners = (res.innerHitsBySlot?.[p.slot] ?? []).map((h) => ({ id: h.innerId, amount: h.amount }));
      wounds.push({ slotRef: p.slot, amount: p.total, initialAmount: p.total, type: dominant?.type ?? 'ballistic', inners });
      damageBySlot[p.slot] = (damageBySlot[p.slot] ?? 0) + p.total;
      for (const h of inners) organHits.push({ slot: p.slot, id: h.id });
    }
    const body = nameBodyParts(loadAnatomy(el.anatomyId || 'humanoid'), names);
    if (hpOverride > 0 && body.bodyParts[partId]) body.bodyParts[partId].maxHp = hpOverride;
    const state = applyBodyState(body.bodyParts, wounds, { rootRef: body.root });
    const outcome = classifyOutcome({ bodyParts: body.bodyParts, ...state }, { hitSlot: partId, damageBySlot, organHits });
    const after = body.bodyParts[partId] ?? {};
    // The hit part as the body shows it after this hit (saturation, disabled below 0, destroyed below its reserve).
    const hp = { current: num(after.currentHp, 0), max: num(after.effectiveMaxHp, 0), disabled: after.disabled === true, lost: after.lost === true };
    perShot.push({
      n, entry, parts, wound, organs, outcome, hp,
      bleeding: { rate: state.bleeding.rate, minutesToDeath: Number.isFinite(state.bleeding.minutesToDeath) ? state.bleeding.minutesToDeath : null },
      exit: snapshot(res.exitApplications ?? []),
      path: res.path.map((p) => ({ slotRef: p.slotRef, entryKind: p.entryKind, exited: p.exited, transferredTo: p.transferredTo })),
      armorLayers, trace: compactTrace(res.trace),
    });
    armorBySlot = res.armorUpdatesBySlot;
  }
  return { partId, partName: partLabel(part, partId, names), hitDirection, anatomyId: anatomy.id, shots: perShot, layers: cleanLayers(armorLayersOf(el.armor, items, mode)) };
}

/* ------------------------------------------------------------------ *
 *  Cases -> simulation                                                *
 * ------------------------------------------------------------------ */

/**
 * The simulation request a case row stands for, or `null` when it cannot be simulated
 * (no ammo link or no part slot).
 * @param {object} group case group (`ammoItem`, `part`, `weaponItem`)
 * @param {object} row case row (`armor`, `distance`, `face`)
 * @param {Array<object>} partsDict dictionary parts (`{ id, slot, hp }`)
 */
export function requestForCase(group, row, partsDict, extra = {}) {
  if (!group?.ammoItem) return null;
  const part = (partsDict ?? []).find((p) => p.id === group.part);
  if (!part?.slot) return null;
  const distance = Math.max(0, num(row.distance));
  let armor = row.armor ?? { kind: 'none' };
  if (armor.kind === 'item' && !armor.itemId) armor = { kind: 'none' };
  return {
    valuesMode: extra.valuesMode,
    falloff: extra.falloff,
    random: extra.random,
    source: { kind: 'ammo', itemId: group.ammoItem, weaponId: group.weaponItem || undefined },
    elements: [{
      type: 'target', distance, partId: part.slot, hitDirection: row.face,
      armor, shots: extra.shots ?? 1, partHp: part.hp || undefined,
    }],
  };
}

export { clone };
