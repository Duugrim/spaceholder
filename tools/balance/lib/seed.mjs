/**
 * First-run data: dictionaries, armour/wall presets and a few example cases. The case base itself starts
 * almost empty — cases are added in the tool.
 */

/** Outcome scale, worst first. `severity` drives the colour; the list is editable in the tool. */
export const SEED_OUTCOMES = [
  { id: 'death', label: 'Смерть', severity: 6 },
  { id: 'destroyed', label: 'Часть тела уничтожена', severity: 5 },
  { id: 'mortal', label: 'Смертельная травма', severity: 4 },
  { id: 'severe', label: 'Тяжёлая травма', severity: 3 },
  { id: 'light', label: 'Лёгкая травма', severity: 2 },
  { id: 'graze', label: 'Задел, урона нет', severity: 1 },
  { id: 'stopped', label: 'Остановлена, эффекта нет', severity: 0 },
];

export const SEED_WEAPON_TYPES = [
  { id: 'pistols', label: 'Пистолеты' },
  { id: 'smg', label: 'ПП' },
  { id: 'rifles', label: 'Винтовки' },
  { id: 'sniper', label: 'Снайперское' },
  { id: 'shotguns', label: 'Дробовики' },
  { id: 'mg', label: 'Пулемёты' },
  { id: 'heavy', label: 'Тяжёлое' },
  { id: 'melee', label: 'Ближний бой' },
  { id: 'energy', label: 'Энергетическое' },
];

/** Hit parts. `slot` is the humanoid anatomy slot the calculator hits (left side stands for both); `hp` overrides the anatomy HP. */
export const SEED_PARTS = [
  { id: 'head', label: 'Голова', slot: 'head', hp: null },
  { id: 'neck', label: 'Шея', slot: 'neck', hp: null },
  { id: 'upperTorso', label: 'Верх торса', slot: 'upperTorso', hp: null },
  { id: 'lowerTorso', label: 'Низ торса', slot: 'lowerTorso', hp: null },
  { id: 'shoulder', label: 'Плечо', slot: 'leftShoulder', hp: null },
  { id: 'arm', label: 'Рука', slot: 'leftArm', hp: null },
  { id: 'hand', label: 'Кисть', slot: 'leftHand', hp: null },
  { id: 'thigh', label: 'Бедро', slot: 'leftThigh', hp: null },
  { id: 'shin', label: 'Голень', slot: 'leftShin', hp: null },
  { id: 'foot', label: 'Ступня', slot: 'leftFoot', hp: null },
];

export function seedDictionaries() {
  return {
    version: 1,
    revision: 0,
    outcomes: SEED_OUTCOMES.map((o) => ({ ...o })),
    weaponTypes: SEED_WEAPON_TYPES.map((t) => ({ ...t })),
    parts: SEED_PARTS.map((p) => ({ ...p })),
  };
}

/* ------------------------------------------------------------------ *
 *  Presets                                                            *
 * ------------------------------------------------------------------ */

function layersFromArmor(items, armorId, slotRef, face = 'front') {
  const item = items.find((it) => it.id === armorId);
  const cover = (item?.values?.coveredParts ?? []).find((c) => c.slotRef === slotRef && (c.face ?? 'front') === face);
  return (cover?.layers ?? []).map((l) => ({ material: l.material, thickness: l.thickness }));
}

/**
 * Layer presets: armour sets copied from the game's wearables (head for helmets, upper torso front for
 * vests), a metre of steel and a few walls. Plain layer lists, not Foundry items.
 * @param {Array<object>} items imported items (to read layer data from)
 */
export function seedPresets(items) {
  const fromArmor = (id, name, armorId, slot, note) => ({
    id, kind: 'preset', name, group: 'armor', status: 'draft',
    source: { type: 'custom', from: armorId },
    base: null,
    values: { use: 'armor', layers: layersFromArmor(items, armorId, slot) },
    notes: note ?? '',
  });
  const custom = (id, name, use, layers, notes = '') => ({
    id, kind: 'preset', name, group: use, status: 'draft',
    source: { type: 'custom' }, base: null, values: { use, layers }, notes,
  });
  return [
    fromArmor('preset.helm-light', 'Лёгкая каска', 'armor.шлем-лёгкий', 'head'),
    fromArmor('preset.helm-mid', 'Средняя каска', 'armor.шлем-средний', 'head'),
    fromArmor('preset.helm-heavy', 'Тяжёлая каска', 'armor.шлем-тяжёлый', 'head'),
    fromArmor('preset.vest-light', 'Лёгкий жилет', 'armor.бронежилет-лёгкий', 'upperTorso'),
    fromArmor('preset.vest-mid', 'Средний жилет', 'armor.бронежилет-средний', 'upperTorso'),
    fromArmor('preset.vest-ceramic', 'Керамический жилет', 'armor.бронежилет-керамика', 'upperTorso'),
    fromArmor('preset.vest-heavy', 'Тяжёлый жилет', 'armor.бронежилет-тяжёлый', 'upperTorso'),
    custom('preset.steel-1m', 'Сталь 1 м', 'both', [{ material: 'steel-plate', thickness: 1000 }], 'Крайний случай из диктовки: пистолет против метра стали.'),
    custom('preset.wall-drywall', 'Гипсокартон 15 мм', 'wall', [{ material: 'drywall', thickness: 15 }]),
    custom('preset.wall-wood', 'Дерево 50 мм', 'wall', [{ material: 'wood', thickness: 50 }]),
    custom('preset.wall-brick', 'Кирпич 120 мм', 'wall', [{ material: 'brick', thickness: 120 }]),
    custom('preset.wall-concrete', 'Бетон 200 мм', 'wall', [{ material: 'concrete', thickness: 200 }]),
  ];
}

/* ------------------------------------------------------------------ *
 *  Example cases                                                      *
 * ------------------------------------------------------------------ */

/**
 * The case base starts almost empty: one global case with the variants from the owner's dictation
 * (a bare head, a head behind a metre of steel, a bare head at 100 m). Everything else is added in the tool.
 * Outcomes are left empty — they are decided in the brainstorm.
 */
export function seedCases() {
  const group = {
    id: 'g.example-pistol-head',
    weaponType: 'pistols',
    weapon: 'Пистолет',
    ammo: '9×19',
    ammoItem: 'ammo.9mm',
    weaponItem: '',
    part: 'head',
    note: 'Пример из диктовки: пистолетный патрон в голову чаще убивает, но не всегда — пуля может не дойти до мозга.',
    favorite: false,
  };
  const row = (n, seed) => ({
    id: `r.example-${n}`, groupId: group.id, armor: { kind: 'none' }, face: 'front', distance: 0, condition: '',
    worst: null, best: null, note: '', ...seed,
  });
  return {
    version: 1,
    revision: 0,
    groups: [group],
    rows: [
      row(1, {}),
      row(2, { armor: { kind: 'preset', presetId: 'preset.steel-1m' }, note: 'Метр стали: пистолет не делает ничего.' }),
      row(3, { distance: 100, note: 'Со 100 м пистолетная пуля может останавливаться черепом.' }),
    ],
  };
}
