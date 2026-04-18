/**
 * Extract canonical body-part identifier from coverage entry.
 * Supports current `slotRef` and legacy `partId`.
 * @param {object} entry
 * @returns {string}
 */
export function getCanonicalPartId(entry) {
  return String(entry?.slotRef ?? entry?.partId ?? '').trim();
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

  const resolved = new Set();
  for (const [slotRef, part] of Object.entries(bodyParts)) {
    const partId = String(part?.id ?? '').trim();
    if (partId && partId === id) resolved.add(slotRef);
  }
  if (Object.prototype.hasOwnProperty.call(bodyParts, id)) resolved.add(id);
  return Array.from(resolved);
}

/**
 * Resolve coverage entry into canonical id + matched actor slot refs.
 * @param {Record<string, object>|null|undefined} bodyParts
 * @param {object} coverageEntry
 * @returns {{ canonicalId: string, slotRefs: string[] }}
 */
export function resolveCoverageEntryToActorSlots(bodyParts, coverageEntry) {
  const canonicalId = getCanonicalPartId(coverageEntry);
  const slotRefs = findActorSlotsForCanonicalPart(bodyParts, canonicalId);
  return { canonicalId, slotRefs };
}
