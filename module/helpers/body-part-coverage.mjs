import { remapLegacyPartId, sanitizeFaces } from './anatomy-groups.mjs';

/**
 * Extract canonical body-part identifier from coverage entry.
 * Supports current `slotRef` and legacy `partId`.
 * @param {object} entry
 * @returns {string}
 */
export function getCanonicalPartId(entry) {
  const raw = String(entry?.slotRef ?? entry?.partId ?? '').trim();
  const legacy = remapLegacyPartId(raw);
  return legacy?.partId ?? raw;
}

/**
 * Face on a coverage entry (`front`/`back`). Legacy chest/back/abdomen map
 * to a face; missing face defaults to `front`.
 * @param {object} entry
 * @returns {string}
 */
export function getCoverageFace(entry) {
  const explicit = String(entry?.face ?? '').toLowerCase().trim();
  if (explicit === 'front' || explicit === 'back') return explicit;
  const raw = String(entry?.slotRef ?? entry?.partId ?? '').trim();
  const legacy = remapLegacyPartId(raw);
  return legacy?.face ?? 'front';
}

export function coverageKey(slotRef, face) {
  const id = String(slotRef ?? '').trim();
  const f = String(face ?? 'front').toLowerCase().trim() || 'front';
  return `${id}::${f}`;
}

export function parseCoverageKey(key) {
  const raw = String(key ?? '');
  const idx = raw.lastIndexOf('::');
  if (idx <= 0) return { slotRef: raw.trim(), face: 'front' };
  return { slotRef: raw.slice(0, idx).trim(), face: raw.slice(idx + 2).trim() || 'front' };
}

/**
 * Resolve actor slot refs for canonical body-part identifier.
 * Match by `part.id` and by direct slot key for compatibility.
 * @param {Record<string, object>|null|undefined} bodyParts
 * @param {string} canonicalId
 * @returns {string[]}
 */
export function findActorSlotsForCanonicalPart(bodyParts, canonicalId) {
  const id = String(canonicalId ?? '').trim();
  if (!id) return [];
  if (!bodyParts || typeof bodyParts !== 'object') return [];

  const remapped = remapLegacyPartId(id)?.partId ?? id;
  const aliases = remapped === 'upperTorso' ? ['chest', 'back']
    : remapped === 'lowerTorso' ? ['abdomen', 'groin']
    : [];
  const resolved = new Set();
  for (const [slotRef, part] of Object.entries(bodyParts)) {
    const partId = String(part?.id ?? '').trim();
    if (partId && (partId === remapped || partId === id || aliases.includes(partId))) resolved.add(slotRef);
  }
  if (Object.prototype.hasOwnProperty.call(bodyParts, remapped)) resolved.add(remapped);
  if (Object.prototype.hasOwnProperty.call(bodyParts, id)) resolved.add(id);
  return Array.from(resolved);
}

/**
 * Resolve coverage entry into canonical id + matched actor slot refs.
 * @param {Record<string, object>|null|undefined} bodyParts
 * @param {object} coverageEntry
 * @returns {{ canonicalId: string, slotRefs: string[], face: string }}
 */
export function resolveCoverageEntryToActorSlots(bodyParts, coverageEntry) {
  const canonicalId = getCanonicalPartId(coverageEntry);
  const slotRefs = findActorSlotsForCanonicalPart(bodyParts, canonicalId);
  return { canonicalId, slotRefs, face: getCoverageFace(coverageEntry) };
}

/**
 * Whether a coverage entry applies to this actor slot and incoming face.
 * Entries without a face cover every face of the part (legacy).
 * @param {Record<string, object>} bodyParts
 * @param {object} entry
 * @param {string} slotRef
 * @param {string} [face]
 */
export function coverageEntryMatchesSlotFace(bodyParts, entry, slotRef, face) {
  const { slotRefs } = resolveCoverageEntryToActorSlots(bodyParts, entry);
  if (!slotRefs.includes(slotRef)) return false;
  const part = bodyParts?.[slotRef];
  const faces = sanitizeFaces(part?.faces);
  const wanted = String(face ?? '').toLowerCase().trim();
  if (!wanted) return true;
  const entryFace = String(entry?.face ?? '').toLowerCase().trim();
  if (!entryFace) {
    // Legacy: remap chest/back still yields a face via getCoverageFace.
    const implied = getCoverageFace(entry);
    if (!faces.includes(implied)) return true;
    return implied === wanted;
  }
  return entryFace === wanted;
}
