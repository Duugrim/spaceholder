/**
 * Test-only material catalog for the v3 damage resolver.
 *
 * Runtime materials are loaded from compendium/world Items. These fixtures are
 * intentionally small and deterministic so Node smoke tests check arithmetic,
 * not live compendium tuning.
 *
 * All numeric fields use v3 conventions:
 *  - `hardness`   : scalar (positive float)
 *  - `resistance` : integer percentage (100 = full resistance for this type)
 *  - `wear`       : integer percentage (damage resolver divides by 100 at runtime)
 *
 * If you intentionally retune a fixture here, expect to recompute the
 * corresponding `approxEqual` expectations in the resolver tests.
 */

import { DEGRADATION_MODES } from '../damage-types.mjs';

/** @type {Object<string, Object>} */
export const TEST_MATERIAL_FIXTURES = Object.freeze({
  'steel-plate': {
    materialId: 'steel-plate',
    name: 'Steel plate',
    category: 'metal',
    hardness: 10,
    integrityPerThickness: 50,
    weightPerThickness: 7.85,
    resistance: {
      ballistic: 100, concussive: 90, piercing: 90, cutting: 120,
      thermal: 45, laser: 40, plasma: 65, electric: 20,
      sonic: 90, radiation: 60, chemical: 25
    },
    wear: {
      ballistic: 40, concussive: 30, piercing: 40, cutting: 20,
      thermal: 50, laser: 40, plasma: 150, electric: 5,
      sonic: 5, radiation: 0, chemical: 100
    },
    conductance: {
      electric: [{ type: 'electric', fraction: 0.9 }]
    },
    selfInduction: {
      ballistic: [
        { type: 'thermal', fraction: 0.2 },
        { type: 'concussive', fraction: 0.3 }
      ],
      piercing: [
        { type: 'thermal', fraction: 0.1 },
        { type: 'concussive', fraction: 0.3 }
      ],
      laser: [{ type: 'thermal', fraction: 0.6 }],
      plasma: [{ type: 'thermal', fraction: 0.4 }]
    },
    degradation: {
      ballistic: DEGRADATION_MODES.BASTION
    }
  },

  kevlar: {
    materialId: 'kevlar',
    name: 'Kevlar weave',
    category: 'fabric',
    hardness: 20,
    integrityPerThickness: 30,
    breachCapacityPerThickness: 30,
    weightPerThickness: 1.4,
    resistance: {
      ballistic: 100, concussive: 55, piercing: 35, cutting: 70,
      thermal: 25, laser: 20, plasma: 25, electric: 10,
      sonic: 40, radiation: 5, chemical: 20
    },
    wear: {
      ballistic: 30, concussive: 15, piercing: 50, cutting: 50,
      thermal: 100, laser: 100, plasma: 150, electric: 0,
      sonic: 5, radiation: 0, chemical: 150
    },
    conductance: {
      ballistic: [{ type: 'concussive', fraction: 0.5 }],
      piercing: [{ type: 'concussive', fraction: 0.3 }]
    },
    selfInduction: {
      ballistic: [{ type: 'thermal', fraction: 0.05 }]
    },
    degradation: {}
  },

  foam: {
    materialId: 'foam',
    name: 'Impact foam',
    category: 'fabric',
    hardness: 6,
    integrityPerThickness: 10,
    weightPerThickness: 0.05,
    resistance: {
      ballistic: 25, concussive: 300, piercing: 20, cutting: 20,
      thermal: 50, laser: 15, plasma: 25, electric: 100,
      sonic: 150, radiation: 0, chemical: 10
    },
    wear: {
      ballistic: 50, concussive: 30, piercing: 40, cutting: 60,
      thermal: 100, laser: 150, plasma: 200, electric: 5,
      sonic: 5, radiation: 0, chemical: 150
    },
    conductance: {},
    selfInduction: {
      concussive: [{ type: 'thermal', fraction: 0.1 }],
      ballistic: [{ type: 'concussive', fraction: 0.4 }]
    },
    degradation: {
      concussive: DEGRADATION_MODES.REDUCTION
    }
  },

  ablative: {
    materialId: 'ablative',
    name: 'Ablative film',
    category: 'ablative',
    hardness: 12,
    integrityPerThickness: 20,
    weightPerThickness: 0.5,
    resistance: {
      ballistic: 10, concussive: 10, piercing: 10, cutting: 10,
      thermal: 250, laser: 350, plasma: 220, electric: 5,
      sonic: 20, radiation: 25, chemical: 45
    },
    wear: {
      ballistic: 50, concussive: 30, piercing: 50, cutting: 50,
      thermal: 400, laser: 500, plasma: 400, electric: 5,
      sonic: 10, radiation: 50, chemical: 200
    },
    conductance: {},
    selfInduction: {
      thermal: [],
      laser: [],
      plasma: [{ type: 'thermal', fraction: 0.2 }]
    },
    degradation: {
      thermal: DEGRADATION_MODES.REDUCTION,
      laser: DEGRADATION_MODES.REDUCTION
    }
  },

  skin: {
    materialId: 'skin',
    name: 'Skin',
    category: 'biological',
    hardness: 1,
    integrityPerThickness: 5,
    weightPerThickness: 1.1,
    resistance: {
      ballistic: 20, concussive: 40, piercing: 20, cutting: 40,
      thermal: 60, laser: 40, plasma: 20, electric: 20,
      sonic: 20, radiation: 0, chemical: 40
    },
    wear: {
      ballistic: 100, concussive: 50, piercing: 120, cutting: 150,
      thermal: 200, laser: 200, plasma: 250, electric: 10,
      sonic: 10, radiation: 0, chemical: 300
    },
    conductance: {
      thermal: [{ type: 'thermal', fraction: 0.1 }]
    },
    selfInduction: {},
    degradation: {}
  },

  muscle: {
    materialId: 'muscle',
    name: 'Muscle',
    category: 'biological',
    hardness: 2,
    integrityPerThickness: 8,
    weightPerThickness: 1.06,
    resistance: {
      ballistic: 35, concussive: 100, piercing: 70, cutting: 70,
      thermal: 70, laser: 55, plasma: 35, electric: 35,
      sonic: 70, radiation: 0, chemical: 55
    },
    wear: {
      ballistic: 80, concussive: 40, piercing: 90, cutting: 100,
      thermal: 100, laser: 120, plasma: 150, electric: 5,
      sonic: 10, radiation: 0, chemical: 200
    },
    conductance: {},
    selfInduction: {
      ballistic: [{ type: 'concussive', fraction: 0.3 }],
      piercing: [{ type: 'concussive', fraction: 0.3 }]
    },
    degradation: {
      ballistic: DEGRADATION_MODES.DISTRIBUTION,
      concussive: DEGRADATION_MODES.REDUCTION,
      piercing: DEGRADATION_MODES.DISTRIBUTION
    }
  },

  bone: {
    materialId: 'bone',
    name: 'Bone',
    category: 'biological',
    hardness: 8,
    integrityPerThickness: 20,
    breachCapacityPerThickness: 15,
    weightPerThickness: 1.8,
    resistance: {
      ballistic: 100, concussive: 130, piercing: 180, cutting: 150,
      thermal: 75, laser: 60, plasma: 50, electric: 35,
      sonic: 60, radiation: 0, chemical: 50
    },
    wear: {
      ballistic: 40, concussive: 30, piercing: 35, cutting: 40,
      thermal: 60, laser: 80, plasma: 100, electric: 5,
      sonic: 10, radiation: 0, chemical: 100
    },
    conductance: {},
    selfInduction: {
      ballistic: [{ type: 'concussive', fraction: 0.5 }],
      piercing: [{ type: 'concussive', fraction: 0.5 }],
      concussive: [{ type: 'concussive', fraction: 0.3 }]
    },
    degradation: {
      ballistic: DEGRADATION_MODES.BASTION,
      piercing: DEGRADATION_MODES.BASTION,
      cutting: DEGRADATION_MODES.BASTION
    }
  },

  'cloth-light': {
    materialId: 'cloth-light',
    name: 'Light Cloth',
    category: 'fabric',
    hardness: 0.5,
    integrityPerThickness: 2,
    weightPerThickness: 0.2,
    resistance: {
      ballistic: 10, concussive: 10, piercing: 5, cutting: 20,
      thermal: 20, laser: 10, plasma: 5, electric: 5,
      sonic: 0, radiation: 0, chemical: 5
    },
    wear: {
      ballistic: 300, concussive: 100, piercing: 300, cutting: 300,
      thermal: 500, laser: 500, plasma: 500, electric: 5,
      sonic: 10, radiation: 0, chemical: 300
    },
    conductance: {
      ballistic: [{ type: 'concussive', fraction: 0.2 }]
    },
    selfInduction: {},
    degradation: {}
  },

  'cloth-heavy': {
    materialId: 'cloth-heavy',
    name: 'Heavy Cloth',
    category: 'fabric',
    hardness: 2,
    integrityPerThickness: 8,
    weightPerThickness: 0.5,
    resistance: {
      ballistic: 35, concussive: 45, piercing: 25, cutting: 60,
      thermal: 50, laser: 35, plasma: 25, electric: 20,
      sonic: 35, radiation: 10, chemical: 20
    },
    wear: {
      ballistic: 150, concussive: 40, piercing: 150, cutting: 100,
      thermal: 200, laser: 250, plasma: 300, electric: 5,
      sonic: 10, radiation: 0, chemical: 200
    },
    conductance: {
      ballistic: [{ type: 'concussive', fraction: 0.3 }],
      piercing: [{ type: 'concussive', fraction: 0.15 }]
    },
    selfInduction: {},
    degradation: {}
  },

  'combat-composite': {
    materialId: 'combat-composite',
    name: 'Combat Composite',
    category: 'composite',
    hardness: 12,
    integrityPerThickness: 60,
    weightPerThickness: 4.0,
    resistance: {
      ballistic: 130, concussive: 120, piercing: 120, cutting: 120,
      thermal: 70, laser: 55, plasma: 90, electric: 35,
      sonic: 100, radiation: 80, chemical: 45
    },
    wear: {
      ballistic: 20, concussive: 15, piercing: 25, cutting: 15,
      thermal: 40, laser: 30, plasma: 100, electric: 5,
      sonic: 5, radiation: 0, chemical: 80
    },
    conductance: {},
    selfInduction: {
      ballistic: [
        { type: 'concussive', fraction: 0.5 },
        { type: 'thermal', fraction: 0.2 }
      ],
      piercing: [
        { type: 'concussive', fraction: 0.5 },
        { type: 'thermal', fraction: 0.2 }
      ],
      concussive: [{ type: 'thermal', fraction: 0.2 }],
      laser: [{ type: 'thermal', fraction: 0.5 }],
      plasma: [{ type: 'thermal', fraction: 0.4 }]
    },
    degradation: {
      ballistic: DEGRADATION_MODES.BASTION,
      piercing: DEGRADATION_MODES.BASTION,
      cutting: DEGRADATION_MODES.BASTION
    }
  },

  'tank-composite': {
    materialId: 'tank-composite',
    name: 'Tank Composite',
    category: 'composite',
    hardness: 25,
    integrityPerThickness: 100,
    weightPerThickness: 5.5,
    resistance: {
      ballistic: 160, concussive: 140, piercing: 160, cutting: 140,
      thermal: 110, laser: 90, plasma: 140, electric: 45,
      sonic: 120, radiation: 110, chemical: 70
    },
    wear: {
      ballistic: 20, concussive: 10, piercing: 20, cutting: 15,
      thermal: 30, laser: 30, plasma: 60, electric: 5,
      sonic: 5, radiation: 0, chemical: 50
    },
    conductance: {},
    selfInduction: {
      ballistic: [
        { type: 'concussive', fraction: 0.5 },
        { type: 'thermal', fraction: 0.3 }
      ],
      piercing: [
        { type: 'concussive', fraction: 0.5 },
        { type: 'thermal', fraction: 0.3 }
      ],
      concussive: [{ type: 'thermal', fraction: 0.2 }],
      laser: [{ type: 'thermal', fraction: 0.6 }],
      plasma: [{ type: 'thermal', fraction: 0.5 }]
    },
    degradation: {
      ballistic: DEGRADATION_MODES.BASTION,
      piercing: DEGRADATION_MODES.BASTION,
      cutting: DEGRADATION_MODES.BASTION
    }
  }
});

/** @type {string[]} */
export const TEST_MATERIAL_IDS = Object.freeze(Object.keys(TEST_MATERIAL_FIXTURES));
