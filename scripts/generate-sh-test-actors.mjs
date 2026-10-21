/**
 * Build actor JSON for `sh-test-actors` from anatomy + current catalog items.
 *
 * Actors:
 *  - Стрелок — humanoid with starter kit (Glock, AK, laser, armor, ammo)
 *  - Мишень  — single-part target dummy
 *
 * Usage:
 *   npm run generate:sh-test-actors
 *   npm run pack:sh-test-actors      (Foundry closed)
 *
 * Shared builders: `scripts/lib/sh-actor-builder.mjs` (the test scenes use them too).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, buildCharacter, makeCharacterSystem, makePrototypeToken, makeStats, writeJson,
} from './lib/sh-actor-builder.mjs';

const outDir = path.join(ROOT, 'pack-src', 'sh-test-actors');
const CREATED_TIME = 1782901000000;

const SHOOTER_ID = 'shcactshooter000';
const TARGET_ID = 'shcacttarget0000';

function wipeActors() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(outDir, name));
  }
}

function buildShooter() {
  // 0 AK (held) + 1 mag-S attached; 6 laser pistol + 7 heat sink S attached; spare kit in inventory
  return buildCharacter({
    id: SHOOTER_ID,
    name: 'Стрелок',
    createdTime: CREATED_TIME,
    biography: '<p>Стартовый стрелок каталога: АК в руках, Глок, лазерный пистолет, нож, лёгкая защита.</p>',
    loadout: [
      { prefix: 'SH_Wpn_ak_', held: true },
      { prefix: 'SH_Ammo_7.62x39_mag_s_', attachTo: 0, attachBlockIndex: 0 },
      { prefix: 'SH_Wpn_glock_' },
      { prefix: 'SH_Ammo_9mm_mag_s_', quantity: 2 },
      { prefix: 'SH_Ammo_9mm_round_', quantity: 60 },
      { prefix: 'SH_Ammo_7.62x39_mag_s_', quantity: 2 },
      { prefix: 'SH_Wpn_lasPistol_' },
      { prefix: 'SH_Ammo_heat_s_', quantity: 1, attachTo: 6, attachBlockIndex: 0 },
      { prefix: 'SH_Wpn_knife_' },
      { prefix: 'SH_Wear_casual_', equipped: true },
      { prefix: 'SH_Wear_vest-light_', equipped: true },
      { prefix: 'SH_Wear_helm-light_', equipped: true },
    ],
  });
}

function buildTarget() {
  const slotRef = 'chest#1';
  const bodyParts = {
    [slotRef]: {
      id: 'chest',
      name: 'Мишень',
      slotRef,
      uuid: `${TARGET_ID}-bp-chest-1`,
      weight: 100,
      maxHp: 500,
      x: 4,
      y: 4,
      status: 'healthy',
      internal: false,
      tags: ['core'],
      organs: [],
      exposure: { front: 100, right: 100, back: 100, left: 100 },
      relations: [],
      links: [],
    },
  };

  return {
    name: 'Мишень',
    type: 'character',
    _id: TARGET_ID,
    img: 'icons/svg/target.svg',
    system: makeCharacterSystem({
      anatomyId: 'target',
      anatomyName: 'Target Dummy',
      bodyParts,
      rootRef: slotRef,
      anatomyGrid: { width: 9, height: 10 },
      biography: '<p>Одночастная мишень для проверки стрельбы и брони.</p>',
    }),
    prototypeToken: makePrototypeToken({
      name: 'Мишень',
      src: 'icons/svg/target.svg',
      disposition: -1,
    }),
    items: [],
    effects: [],
    folder: null,
    sort: 200000,
    ownership: { default: 0 },
    flags: {},
    _stats: makeStats(CREATED_TIME, 1),
    _key: `!actors!${TARGET_ID}`,
  };
}

function main() {
  console.log('generating actors…');
  wipeActors();
  const shooter = buildShooter();
  const target = buildTarget();
  writeJson(path.join(outDir, `SH_Shooter_${SHOOTER_ID}.json`), shooter);
  writeJson(path.join(outDir, `SH_Target_${TARGET_ID}.json`), target);
  console.log(`done: shooter items=${shooter.items.length}, target items=0`);
}

main();
