/**
 * Default body-layer stacks for anatomy body parts.
 *
 * A body part can carry its own `bodyLayers` — a **unidirectional** stack
 * «from the outer shell of the part towards its geometric centre». The
 * traversal resolver walks this stack forward on external entry and in
 * reverse on external exit; see
 * [module/helpers/damage/body-traversal-resolver.mjs] and
 * [docs/code/reference/ANATOMY_SYSTEM.md] §«Слои тела».
 *
 * These defaults exist for two reasons:
 *  - Fallback for actors whose data predates the `bodyLayers` field.
 *  - Programmatic access for documentation / tests that need a «basic
 *    skin → muscle → bone» stack without hard-coding numbers.
 *
 * Note: `organs` are intentionally not modelled here. In the current
 * scope they live as separate critical structures on the part (see
 * `bodyPart.organs`) and are resolved after `bodyDamage` by unrelated
 * mechanics.
 */

/**
 * Generic fallback stack — roughly a humanoid torso cross-section.
 * Each entry is `{ material, thickness }`.
 * @type {ReadonlyArray<{ material: string, thickness: number }>}
 */
export const DEFAULT_BODY_LAYERS = Object.freeze([
  Object.freeze({ material: 'skin', thickness: 1 }),
  Object.freeze({ material: 'muscle', thickness: 2 }),
  Object.freeze({ material: 'bone', thickness: 1 })
]);

/**
 * Per-typeId overrides applied when an actor body part lacks explicit
 * `bodyLayers` *and* the anatomy preset also didn't supply them. Kept as
 * plain arrays of `{material, thickness}` tuples so callers can freely
 * clone and mutate the result.
 *
 * The keys here are body-part **typeIds** (e.g. `head`, `chest`) — i.e.
 * the value of `part.id` after normalisation, not the raw JSON key and
 * not the slotRef.
 *
 * Missing typeIds fall back to {@link DEFAULT_BODY_LAYERS}.
 */
const DEFAULTS_BY_TYPE_ID = Object.freeze({
  // ---- humanoid --------------------------------------------------------
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

  // ---- quadruped -------------------------------------------------------
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

  // ---- arachnid (approximation: chitin via "bone", flesh via "muscle") --
  cephalothorax:   [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }, { material: 'bone', thickness: 2 }],
  abdomenSegment:  [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 1 }],
  leftLeg:         [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }],
  rightLeg:        [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 1 }, { material: 'bone', thickness: 1 }]
});

/**
 * Build a fresh `bodyLayers` array (plain objects, caller-owned) for the
 * given body-part typeId. Unknown typeIds fall back to
 * {@link DEFAULT_BODY_LAYERS}.
 *
 * @param {string} typeId
 * @returns {Array<{ material: string, thickness: number }>}
 */
export function getDefaultBodyLayersForType(typeId) {
  const key = String(typeId ?? '').trim();
  const src = DEFAULTS_BY_TYPE_ID[key] ?? DEFAULT_BODY_LAYERS;
  return src.map((l) => ({ material: String(l.material), thickness: Number(l.thickness) }));
}

/**
 * Shallow sanitize a raw `bodyLayers` value: keep only entries with a
 * non-empty `material` string and a positive `thickness`. Returns a new
 * array of plain objects, suitable for writing into `bodyParts[k]`.
 *
 * `bodyLayers` is optional: callers decide whether to substitute defaults
 * from {@link getDefaultBodyLayersForType} when the value is absent.
 *
 * @param {unknown} raw
 * @returns {Array<{ material: string, thickness: number }> | null}
 *   Normalized array, or `null` if the input is not an array.
 */
export function sanitizeBodyLayers(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const material = String(entry.material ?? '').trim();
    if (!material) continue;
    const thickness = Number(entry.thickness ?? 0);
    if (!Number.isFinite(thickness) || thickness <= 0) continue;
    out.push({ material, thickness });
  }
  return out;
}

/**
 * Runtime sync for an actor body part: if `part.bodyLayers` is missing
 * or unusable (e.g. actor data predates the `bodyLayers` field), fill
 * it with the preset default from {@link getDefaultBodyLayersForType}.
 *
 * An explicit empty array (`part.bodyLayers = []`) is **kept as-is** —
 * parts without a tissue stack are a legitimate configuration (think
 * «gas bladder», «magic construct», etc.). Only `null`, `undefined` and
 * non-array values trigger the fallback.
 *
 * Mirrors the shape of
 * [`ensureActorPartRelationsSynced`](../anatomy-relations.mjs) so the
 * two helpers can be called in sequence from `Actor#prepareDerivedData`.
 *
 * @param {Object} part - a single `bodyParts[slotRef]` object
 */
export function ensureActorPartBodyLayersSynced(part) {
  if (!part || typeof part !== 'object') return;
  const sanitized = sanitizeBodyLayers(part.bodyLayers);
  if (Array.isArray(sanitized)) {
    part.bodyLayers = sanitized;
    return;
  }
  part.bodyLayers = getDefaultBodyLayersForType(String(part.id ?? ''));
}
