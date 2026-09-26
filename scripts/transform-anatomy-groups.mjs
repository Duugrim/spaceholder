/**
 * One-shot transform: anatomy presets + wearable coveredParts remap.
 * Run: node scripts/transform-anatomy-groups.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STRIP = ['status', 'internal', 'weight', 'exposure', 'bodyLayers', 'position3d', 'organs'];

const HEIGHT_FRAC = {
  head: 0.93,
  neck: 0.88,
  upperTorso: 0.70,
  lowerTorso: 0.55,
  leftShoulder: 0.78,
  rightShoulder: 0.78,
  leftArm: 0.62,
  rightArm: 0.62,
  leftHand: 0.48,
  rightHand: 0.48,
  leftThigh: 0.40,
  rightThigh: 0.40,
  leftShin: 0.18,
  rightShin: 0.18,
  leftFoot: 0.03,
  rightFoot: 0.03,
  torso: 0.55,
  tail: 0.45,
  cephalothorax: 0.55,
  abdomenSegment: 0.40,
};

const MATERIAL = {
  head: 'bone',
  neck: 'muscle',
  upperTorso: 'muscle',
  lowerTorso: 'muscle',
  leftHand: 'skin',
  rightHand: 'skin',
  leftFoot: 'skin',
  rightFoot: 'skin',
};

const TORSO_IDS = new Set(['upperTorso', 'lowerTorso', 'torso', 'cephalothorax', 'abdomenSegment']);

function rel(kind, target, extra = {}) {
  return { kind, target, ...extra };
}

function cleanPart(part, typeId) {
  const next = { ...part };
  for (const k of STRIP) delete next[k];
  next.id = typeId;
  next.material = MATERIAL[typeId] || next.material || 'skin';
  if (next.material === 'biological' || next.material === 'bionic' || next.material === 'flesh' || next.material === 'cybernetic') {
    next.material = MATERIAL[typeId] || 'skin';
  }
  next.faces = TORSO_IDS.has(typeId) ? ['front', 'back'] : ['front'];
  next.heightFrac = HEIGHT_FRAC[typeId] ?? 0.5;
  if (typeId.startsWith('leftLeg') || typeId.startsWith('rightLeg') || /Leg|Paw|Hip|Shoulder|Arm/.test(typeId)) {
    if (HEIGHT_FRAC[typeId] == null) next.heightFrac = 0.25;
  }
  next.inners = Array.isArray(next.inners) ? next.inners : [];
  if (!Array.isArray(next.tags)) next.tags = [];
  if (!Array.isArray(next.relations)) next.relations = [];
  next.relations = next.relations
    .filter((r) => r && r.target)
    .map((r) => {
      const copy = { ...r };
      if (copy.target === 'chest' || copy.target === 'back') copy.target = 'upperTorso';
      if (copy.target === 'abdomen' || copy.target === 'groin') copy.target = 'lowerTorso';
      return copy;
    })
    .filter((r) => r.target !== typeId);
  return next;
}

function transformHumanoid(data) {
  const src = data.bodyParts;
  const chest = src.chest || {};
  const abdomen = src.abdomen || {};
  const groin = src.groin || {};
  const back = src.back || {};

  const upperTorso = cleanPart({
    ...chest,
    id: 'upperTorso',
    name: 'Upper Torso',
    maxHp: 50,
    x: 4,
    y: 3,
    tags: ['core', 'vital', 'armor_chest'],
    relations: [
      rel('adjacent', 'neck'),
      rel('adjacent', 'lowerTorso'),
      rel('adjacent', 'leftShoulder'),
      rel('adjacent', 'rightShoulder'),
    ],
  }, 'upperTorso');
  upperTorso.inners = [
    { id: 'heart', name: 'Heart', material: 'muscle', occupancyPct: 15, statuses: [] },
    { id: 'lungs', name: 'Lungs', material: 'skin', occupancyPct: 40, statuses: [] },
  ];

  const lowerTorso = cleanPart({
    ...abdomen,
    id: 'lowerTorso',
    name: 'Lower Torso',
    maxHp: 45,
    x: 4,
    y: 4,
    tags: ['core', 'armor_chest'],
    relations: [
      rel('adjacent', 'upperTorso'),
      rel('adjacent', 'leftThigh'),
      rel('adjacent', 'rightThigh'),
      rel('parent', 'upperTorso'),
    ],
  }, 'lowerTorso');
  lowerTorso.inners = [
    { id: 'guts', name: 'Guts', material: 'skin', occupancyPct: 50, statuses: [] },
  ];

  const out = {};
  const order = [
    'head', 'neck', 'upperTorso', 'lowerTorso',
    'leftShoulder', 'rightShoulder', 'leftArm', 'rightArm', 'leftHand', 'rightHand',
    'leftThigh', 'rightThigh', 'leftShin', 'rightShin', 'leftFoot', 'rightFoot',
  ];
  for (const id of order) {
    if (id === 'upperTorso') { out.upperTorso = upperTorso; continue; }
    if (id === 'lowerTorso') { out.lowerTorso = lowerTorso; continue; }
    if (!src[id]) continue;
    const p = cleanPart(src[id], id);
    if (id === 'head') {
      p.inners = [
        { id: 'eyes', name: 'Eyes', material: 'skin', occupancyPct: 8, statuses: [] },
        { id: 'ears', name: 'Ears', material: 'skin', occupancyPct: 4, statuses: [] },
        { id: 'brain', name: 'Brain', material: 'skin', occupancyPct: 30, statuses: [] },
      ];
    }
    if (id === 'neck') {
      p.relations = [
        rel('adjacent', 'head'),
        rel('adjacent', 'upperTorso'),
        rel('parent', 'upperTorso'),
      ];
    }
    if (id === 'leftShoulder' || id === 'rightShoulder') {
      p.relations = p.relations.map((r) => (
        r.target === 'chest' || r.target === 'upperTorso'
          ? { ...r, target: 'upperTorso' }
          : r
      ));
      if (!p.relations.some((r) => r.kind === 'parent')) {
        p.relations.push(rel('parent', 'upperTorso'));
      }
    }
    if (id === 'leftThigh' || id === 'rightThigh') {
      p.relations = p.relations
        .map((r) => (r.target === 'groin' || r.target === 'abdomen' ? { ...r, target: 'lowerTorso' } : r))
        .filter((r) => r.target !== 'groin');
      if (!p.relations.some((r) => r.kind === 'parent')) {
        p.relations.push(rel('parent', 'lowerTorso'));
      }
      if (!p.relations.some((r) => r.kind === 'adjacent' && r.target === 'lowerTorso')) {
        p.relations.push(rel('adjacent', 'lowerTorso'));
      }
    }
    out[id] = p;
  }

  return {
    id: 'humanoid',
    name: 'Humanoid',
    description: 'Human-like anatomy: head, neck, upper/lower torso (front/back faces), limbs. No separate back circle.',
    version: '3.0.0',
    heightM: 1.75,
    grid: { width: 9, height: 10 },
    groups: [
      { id: 'legs', type: 'movement', name: 'Legs', parts: ['leftThigh', 'rightThigh', 'leftShin', 'rightShin', 'leftFoot', 'rightFoot'] },
      { id: 'arms', type: 'manipulation', name: 'Arms', parts: ['leftShoulder', 'rightShoulder', 'leftArm', 'rightArm', 'leftHand', 'rightHand'] },
      { id: 'senses', type: 'sensory', name: 'Senses', parts: ['head'] },
      { id: 'vitals', type: 'critical', name: 'Vitals', parts: ['head', 'neck', 'upperTorso', 'lowerTorso'] },
    ],
    bodyParts: out,
  };
}

function transformGeneric(data, extras) {
  const bodyParts = {};
  for (const [key, part] of Object.entries(data.bodyParts || {})) {
    const typeId = String(part?.id ?? key);
    bodyParts[key] = cleanPart(part, typeId);
  }
  return {
    ...data,
    version: '3.0.0',
    heightM: extras.heightM ?? 1.2,
    groups: extras.groups ?? [],
    bodyParts,
  };
}

function writeAnatomy(relPath, data) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log('wrote', relPath);
}

function remapCoverageEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const slot = String(entry.slotRef ?? entry.partId ?? '').trim();
  const map = {
    chest: { slotRef: 'upperTorso', face: 'front' },
    back: { slotRef: 'upperTorso', face: 'back' },
    abdomen: { slotRef: 'lowerTorso', face: 'front' },
    groin: { slotRef: 'lowerTorso', face: 'front' },
  };
  const mapped = map[slot];
  if (mapped) {
    return { ...entry, slotRef: mapped.slotRef, face: entry.face || mapped.face };
  }
  if (slot && !entry.face) {
    const torso = slot === 'upperTorso' || slot === 'lowerTorso' || slot === 'torso'
      || slot === 'cephalothorax' || slot === 'abdomenSegment';
    return { ...entry, slotRef: slot, face: torso ? 'front' : 'front' };
  }
  return entry;
}

function walkJsonFiles(dir, fn) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkJsonFiles(full, fn);
    else if (name.endsWith('.json')) fn(full);
  }
}

const humanoidSrc = JSON.parse(fs.readFileSync(path.join(root, 'data/anatomy/humanoid.json'), 'utf8'));
const humanoid = transformHumanoid(humanoidSrc);
writeAnatomy('data/anatomy/humanoid.json', humanoid);
writeAnatomy('module/data/anatomy/humanoid.json', humanoid);

const quadrupedSrc = JSON.parse(fs.readFileSync(path.join(root, 'data/anatomy/quadruped.json'), 'utf8'));
const qParts = Object.keys(quadrupedSrc.bodyParts);
const qLegs = qParts.filter((k) => /Leg|Paw|Hip|Shoulder|Shin|Thigh|Foot/.test(k) || /front|back/.test(k) && /Left|Right/.test(k));
const quadruped = transformGeneric(quadrupedSrc, {
  heightM: 0.9,
  groups: [
    { id: 'walk', type: 'movement', name: 'Walk', parts: qParts.filter((k) => /Shoulder|Hip|Leg|Paw|Shin|Thigh|Foot/.test(k)) },
    { id: 'senses', type: 'sensory', name: 'Senses', parts: ['head'] },
    { id: 'vitals', type: 'critical', name: 'Vitals', parts: qParts.filter((k) => ['head', 'neck', 'torso'].includes(k)) },
  ],
});
writeAnatomy('data/anatomy/quadruped.json', quadruped);
writeAnatomy('module/data/anatomy/quadruped.json', quadruped);

const arachnidSrc = JSON.parse(fs.readFileSync(path.join(root, 'data/anatomy/arachnid.json'), 'utf8'));
const aParts = Object.keys(arachnidSrc.bodyParts);
const arachnid = transformGeneric(arachnidSrc, {
  heightM: 0.4,
  groups: [
    { id: 'walk', type: 'movement', name: 'Walk', parts: aParts.filter((k) => /Leg/.test(k)) },
    { id: 'senses', type: 'sensory', name: 'Senses', parts: ['cephalothorax'] },
    { id: 'vitals', type: 'critical', name: 'Vitals', parts: aParts.filter((k) => ['cephalothorax', 'abdomenSegment'].includes(k)) },
  ],
});
writeAnatomy('data/anatomy/arachnid.json', arachnid);
writeAnatomy('module/data/anatomy/arachnid.json', arachnid);

let coverageFiles = 0;
walkJsonFiles(path.join(root, 'pack-src'), (full) => {
  const text = fs.readFileSync(full, 'utf8');
  if (!text.includes('coveredParts')) return;
  const data = JSON.parse(text);
  let changed = false;
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.coveredParts)) {
      obj.coveredParts = obj.coveredParts.map((e) => {
        const next = remapCoverageEntry(e);
        if (JSON.stringify(next) !== JSON.stringify(e)) changed = true;
        return next;
      });
    }
    if (obj.system) visit(obj.system);
    if (Array.isArray(obj.items)) obj.items.forEach(visit);
    if (obj.items && typeof obj.items === 'object' && !Array.isArray(obj.items)) {
      for (const it of Object.values(obj.items)) visit(it);
    }
  };
  visit(data);
  if (data.system) visit(data);
  // embedded actor items
  if (Array.isArray(data.items)) data.items.forEach(visit);
  if (changed) {
    fs.writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    coverageFiles += 1;
    console.log('coverage', path.relative(root, full));
  }
});
console.log('coverage files', coverageFiles);
console.log('unused', qLegs.length);
