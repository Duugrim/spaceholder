/** Static knowledge shared by the database editor and the calculator. */

export const DAMAGE_TYPES = Object.freeze([
  { id: 'ballistic', label: 'Баллистический' },
  { id: 'concussive', label: 'Ударный' },
  { id: 'piercing', label: 'Колющий' },
  { id: 'cutting', label: 'Режущий' },
  { id: 'thermal', label: 'Тепловой' },
  { id: 'laser', label: 'Лазерный' },
  { id: 'plasma', label: 'Плазменный' },
  { id: 'electric', label: 'Электрический' },
  { id: 'sonic', label: 'Звуковой' },
  { id: 'radiation', label: 'Радиация' },
  { id: 'chemical', label: 'Химический' },
]);

export const damageTypeLabel = (id) => DAMAGE_TYPES.find((t) => t.id === id)?.label ?? id;

export const KINDS = Object.freeze([
  { id: 'material', label: 'Материалы', one: 'материал' },
  { id: 'ammo', label: 'Боеприпасы', one: 'боеприпас' },
  { id: 'weapon', label: 'Оружие', one: 'оружие' },
  { id: 'armor', label: 'Броня', one: 'броня' },
  { id: 'preset', label: 'Наборы слоёв', one: 'набор' },
]);

export const PRESET_USES = Object.freeze([
  { value: 'armor', label: 'Броня' },
  { value: 'wall', label: 'Стена' },
  { value: 'both', label: 'Броня и стена' },
]);

export const FACES = Object.freeze([
  { value: 'front', label: 'спереди' },
  { value: 'side', label: 'сбоку' },
  { value: 'back', label: 'сзади' },
]);

export const faceLabel = (value) => FACES.find((f) => f.value === value)?.label ?? 'спереди';

/** A new damage entry as the game stores it on ammo and weapon lines. */
export function blankDamageEntry() {
  return {
    enabled: true, damageType: 'ballistic', damage: 10, effortShare: 0, armorPen: 100, hardness: 1,
    armorDamageFactor: 100, armorDamageReduction: 100, speed: 0, payloadId: '',
  };
}

/** Projectile energy of one damage entry: damage x (armorPen/100)^2 x hardness. */
export function entryEnergy(entry, effort = 100) {
  const damage = Math.max(0, Number(entry.damage) || 0) + (Math.max(0, Number(entry.effortShare) || 0) / 100) * effort;
  const ap = Math.max(0, Number(entry.armorPen) || 0) / 100;
  const hardness = Number(entry.hardness) > 0 ? Number(entry.hardness) : 1;
  return damage * ap * ap * hardness;
}

export function blankValues(kind) {
  switch (kind) {
    case 'material':
      return {
        category: 'metal', hardness: 1, integrityPerThickness: 10, breachCapacityPerThickness: 0, weightPerThickness: 1,
        resistance: Object.fromEntries(DAMAGE_TYPES.map((t) => [t.id, 0])),
        wear: Object.fromEntries(DAMAGE_TYPES.map((t) => [t.id, 0])),
        conductance: {}, selfInduction: {}, degradation: {},
      };
    case 'ammo':
      return {
        caliber: '', damage: [blankDamageEntry()], falloff: { enabled: false, halfDistance: 0 },
        multishot: { enabled: false, count: 1, coneDegrees: 0 }, onHitSplash: { enabled: false, radius: 0, unit: 'grid' },
      };
    case 'armor':
      return { anatomyId: 'humanoid', coveredParts: [] };
    case 'preset':
      return { use: 'armor', layers: [] };
    default:
      return {};
  }
}
