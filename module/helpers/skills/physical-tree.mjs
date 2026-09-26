import { SKILL_CUSTOM_WEIGHT } from './skills-const.mjs';

function n(id, weight, opts = {}, children = []) {
  const node = {
    id,
    weight,
    labelKey: `SPACEHOLDER.Skills.Nodes.${String(id).replaceAll('.', '_')}`,
    children,
  };
  if (opts.allowCustom) {
    node.allowCustom = true;
    node.customWeight = Number(opts.customWeight) > 0 ? Number(opts.customWeight) : SKILL_CUSTOM_WEIGHT;
  }
  return node;
}

const cls = (id, weight = 4) => n(id, weight, { allowCustom: true });

/**
 * Draft physical skill trees (combat + physical development).
 * Source of truth at runtime; mirrored in `data/skills/physical-tree.json`.
 */
export const PHYSICAL_SKILL_TREES = Object.freeze([
  n('combat', 1, {}, [
    n('combat.melee', 1.5, {}, [
      n('combat.melee.blade', 2.5, {}, [
        cls('combat.melee.blade.knife'),
        cls('combat.melee.blade.sword'),
        cls('combat.melee.blade.spear'),
      ]),
      n('combat.melee.thrown', 2.5, {}, [
        cls('combat.melee.thrown.dart'),
      ]),
    ]),
    n('combat.ranged', 1.5, {}, [
      n('combat.ranged.firearms', 2.5, {}, [
        cls('combat.ranged.firearms.pistol'),
        cls('combat.ranged.firearms.smg'),
        cls('combat.ranged.firearms.shotgun'),
        cls('combat.ranged.firearms.rifle'),
        cls('combat.ranged.firearms.sniper'),
        cls('combat.ranged.firearms.mg'),
      ]),
      n('combat.ranged.laser', 2.5, {}, [
        cls('combat.ranged.laser.pistol'),
        cls('combat.ranged.laser.smg'),
        cls('combat.ranged.laser.shotgun'),
        cls('combat.ranged.laser.rifle'),
        cls('combat.ranged.laser.heavy'),
      ]),
      n('combat.ranged.plasma', 2.5, {}, [
        cls('combat.ranged.plasma.pistol'),
        cls('combat.ranged.plasma.rifle'),
        cls('combat.ranged.plasma.heavy'),
      ]),
      n('combat.ranged.heavy', 2.5, {}, [
        cls('combat.ranged.heavy.rocket'),
      ]),
    ]),
  ]),
  n('physdev', 1, {}, [
    n('physdev.light', 1.5),
    n('physdev.heavy', 1.5),
  ]),
]);
