#!/usr/bin/env node
/**
 * One-shot migration: inject per-part `bodyLayers` into anatomy JSONs.
 *
 * By default patches the system's own anatomies:
 *   - `data/anatomy/*.json`        (runtime)
 *   - `module/data/anatomy/*.json` (repo mirror)
 *
 * Optionally, a Foundry Data worlds folder can be scanned for world
 * anatomies. Each world's anatomies live at
 *   `<worldsRoot>/<worldId>/spaceholder/anatomy/*.json`.
 *
 * Usage:
 *   node scripts/add-body-layers-to-anatomies.mjs
 *   node scripts/add-body-layers-to-anatomies.mjs --worlds-root <path>
 *   # e.g.   --worlds-root "E:/FoundryVTT/Data/worlds"
 *
 * `bodyLayers` is a **unidirectional** stack from the outer shell of the
 * part towards its geometric centre (skin → muscle → bone). Through-and-
 * through traversal is handled by the resolver, not the JSON, so we do
 * NOT store a mirrored stack here.
 *
 * Re-run is safe: already-present `bodyLayers` are left untouched.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { worldsRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--worlds-root') {
      out.worldsRoot = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--worlds-root=')) {
      out.worldsRoot = arg.slice('--worlds-root='.length);
    }
  }
  return out;
}

const DEFAULT_STACK = [
  { material: 'skin', thickness: 1 },
  { material: 'muscle', thickness: 2 },
  { material: 'bone', thickness: 1 }
];

const BY_TYPE_ID = {
  // humanoid
  head:            [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 3 }],
  neck:            [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 1 }],
  chest:           [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 2 }],
  abdomen:         [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 4 }, { material: 'bone', thickness: 1 }],
  back:            [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 2 }],
  groin:           [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 1 }],
  leftShoulder:    [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  rightShoulder:   [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  leftArm:         [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  rightArm:        [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  leftHand:        [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  rightHand:       [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  leftThigh:       [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 4 }, { material: 'bone', thickness: 1 }],
  rightThigh:      [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 4 }, { material: 'bone', thickness: 1 }],
  leftShin:        [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  rightShin:       [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  leftFoot:        [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  rightFoot:       [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  // quadruped
  torso:           [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 4 }, { material: 'bone', thickness: 2 }],
  frontLeftShoulder:  [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  frontRightShoulder: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  backLeftHip:     [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  backRightHip:    [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  frontLeftLeg:    [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  frontRightLeg:   [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  backLeftLeg:     [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  backRightLeg:    [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  frontLeftPaw:    [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  frontRightPaw:   [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  backLeftPaw:     [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  backRightPaw:    [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  tail:            [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  // arachnid (chitin → "bone", flesh → "muscle")
  cephalothorax:   [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  abdomenSegment:  [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  leftLeg:         [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  rightLeg:        [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }]
};

function layersFor(typeId) {
  return BY_TYPE_ID[typeId] ?? DEFAULT_STACK;
}

async function patchFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !data.bodyParts) {
    console.log(`[skip] ${filePath}: no bodyParts`);
    return;
  }
  let injected = 0;
  let kept = 0;
  for (const [key, part] of Object.entries(data.bodyParts)) {
    if (!part || typeof part !== 'object') continue;
    if (Array.isArray(part.bodyLayers) && part.bodyLayers.length > 0) {
      kept++;
      continue;
    }
    const typeId = String(part.id ?? key).trim();
    part.bodyLayers = layersFor(typeId).map((l) => ({ ...l }));
    injected++;
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`[ok] ${path.relative(ROOT, filePath)}  injected=${injected} kept=${kept}`);
}

async function collectWorldAnatomies(worldsRoot) {
  const out = [];
  let dirents;
  try {
    dirents = await fs.readdir(worldsRoot, { withFileTypes: true });
  } catch (err) {
    console.log(`[err] could not read worlds-root ${worldsRoot}: ${err.message}`);
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const anatomyDir = path.join(worldsRoot, d.name, 'spaceholder', 'anatomy');
    let files;
    try {
      files = await fs.readdir(anatomyDir, { withFileTypes: true });
    } catch {
      continue; // no anatomy folder in this world — skip silently
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.toLowerCase().endsWith('.json')) continue;
      out.push(path.join(anatomyDir, f.name));
    }
  }
  return out;
}

async function main() {
  const { worldsRoot } = parseArgs(process.argv.slice(2));

  const targets = [
    path.join(ROOT, 'data/anatomy/humanoid.json'),
    path.join(ROOT, 'data/anatomy/quadruped.json'),
    path.join(ROOT, 'data/anatomy/arachnid.json'),
    path.join(ROOT, 'module/data/anatomy/humanoid.json'),
    path.join(ROOT, 'module/data/anatomy/quadruped.json'),
    path.join(ROOT, 'module/data/anatomy/arachnid.json')
  ];

  if (worldsRoot) {
    const worldFiles = await collectWorldAnatomies(path.resolve(worldsRoot));
    if (worldFiles.length) {
      console.log(`[info] scanning worlds-root '${worldsRoot}' → ${worldFiles.length} world anatomy file(s)`);
      targets.push(...worldFiles);
    } else {
      console.log(`[info] scanning worlds-root '${worldsRoot}' → no world anatomy files found`);
    }
  }

  for (const t of targets) {
    try {
      await patchFile(t);
    } catch (err) {
      console.log(`[err] ${t}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
