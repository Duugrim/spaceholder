/**
 * Extension points of the system for packages that work alongside it (the Azimuth module today).
 *
 * Nothing here names a package: a package fills the registries, the system asks them. They are plain data and
 * functions with no Foundry dependency, published as `game.spaceholder.integration`
 * (see `docs/code/reference/AZIMUTH_INTEGRATION.md` and AGENTS.md).
 * A provider that throws is logged and skipped, so one broken package cannot take down the host UI.
 */

/** Bumped when a registry changes in a way an integrating package has to know about. */
export const INTEGRATION_API_VERSION = 1;

/** Actor types left out of the create-actor dialog (they stay valid, only creation by hand is hidden). */
export const hiddenActorTypes = new Set();

/** Actor types whose tokens show no pointer unless a token's own flag turns it on. */
export const tokenPointerOffTypes = new Set();

function logProviderError(where, id, err) {
  console.error(`SpaceHolder | integration: ${where} "${id}" failed`, err);
}

function requireId(spec, where) {
  const id = typeof spec?.id === 'string' ? spec.id.trim() : '';
  if (!id) throw new TypeError(`SpaceHolder | integration: ${where} needs a non-empty string id`);
  return id;
}

function requireFunction(value, name, where) {
  if (typeof value !== 'function') throw new TypeError(`SpaceHolder | integration: ${where} needs ${name} to be a function`);
}

/**
 * A map of specs by id. Registering an id again replaces the spec (a package may initialise twice);
 * the returned function removes the spec unless it was replaced since.
 */
function createRegistry() {
  const entries = new Map();
  return {
    add(id, spec) {
      entries.set(id, spec);
      return () => { if (entries.get(id) === spec) entries.delete(id); };
    },
    list: () => [...entries.values()],
    clear: () => entries.clear(),
  };
}

// ---------------------------------------------------------------------------
// Create-actor dialog
// ---------------------------------------------------------------------------

/**
 * Drop the hidden types from the list the create dialog offers.
 * @param {string[]} types  Types the dialog would offer.
 * @param {Set<string>} [hidden=hiddenActorTypes]
 * @returns {string[]|null}  The restricted list, or null when nothing has to change
 *                           (nothing hidden, or hiding would leave no type at all).
 */
export function withoutHiddenTypes(types, hidden = hiddenActorTypes) {
  if (!Array.isArray(types) || !hidden.size) return null;
  const allowed = types.filter((type) => !hidden.has(type));
  if (!allowed.length || allowed.length === types.length) return null;
  return allowed;
}

/**
 * @param {unknown} type
 * @returns {boolean}  Whether tokens of this actor type default to no pointer.
 */
export function isTokenPointerOffType(type) {
  return tokenPointerOffTypes.has(String(type ?? ''));
}

// ---------------------------------------------------------------------------
// Sections of the faction sheet
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FactionSheetSection
 * @property {string} id
 * @property {(args: {actor: Actor, sheet: object, context: object, editable: boolean}) => Promise<string|null>|string|null} render
 *           Markup for the section, or nothing. Runs on every render of the sheet; the markup goes inside the sheet's form,
 *           so inputs named like document fields (`flags.pkg.x`) are saved with the sheet.
 * @property {(container: HTMLElement, args: {actor: Actor, sheet: object, editable: boolean}) => void} [activate]
 *           Wires the section's controls after each render; `container` is the section's own element.
 */
const factionSheetSections = createRegistry();

/**
 * @param {FactionSheetSection} spec
 * @returns {() => void}  Unregister.
 */
export function registerFactionSheetSection(spec) {
  const id = requireId(spec, 'a faction sheet section');
  requireFunction(spec.render, 'render', `faction sheet section "${id}"`);
  if (spec.activate !== undefined) requireFunction(spec.activate, 'activate', `faction sheet section "${id}"`);
  return factionSheetSections.add(id, { id, render: spec.render, activate: spec.activate });
}

/**
 * @param {object} args  Passed to every section's `render`.
 * @returns {Promise<{id: string, html: string}[]>}  The sections that have something to show.
 */
export async function renderFactionSheetSections(args) {
  const out = [];
  for (const section of factionSheetSections.list()) {
    try {
      const html = await section.render(args);
      if (html) out.push({ id: section.id, html: String(html) });
    } catch (err) {
      logProviderError('faction sheet section', section.id, err);
    }
  }
  return out;
}

/**
 * Call `activate` of every section that has an element inside `root` (`[data-faction-section="<id>"]`).
 * @param {{querySelector?: Function}|null|undefined} root
 * @param {object} args  Passed to `activate` together with the section's element.
 */
export function activateFactionSheetSections(root, args) {
  if (!root?.querySelector) return;
  for (const section of factionSheetSections.list()) {
    if (!section.activate) continue;
    try {
      // An id with quotes or brackets would break the selector: escape it, and keep a bad one inside the guard.
      const id = globalThis.CSS?.escape ? globalThis.CSS.escape(section.id) : section.id;
      const container = root.querySelector(`[data-faction-section="${id}"]`);
      if (!container) continue;
      section.activate(container, args);
    } catch (err) {
      logProviderError('faction sheet section activate', section.id, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Faction block of the hotbar
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HotbarQuickAction
 * @property {string} key       Unique within the provider.
 * @property {string} icon      Font Awesome classes.
 * @property {string} label     Tooltip and aria-label: the control's name.
 * @property {boolean} [disabled]
 * @property {boolean} [active]
 * @property {(event: Event, button: HTMLElement) => void|Promise<void>} [onClick]
 *
 * @typedef {object} HotbarIndicator
 * @property {string} key
 * @property {string} text
 * @property {string} [tooltip]
 *
 * @typedef {object} HotbarFactionItems
 * @property {string} id
 * @property {(ctx: object) => Promise<HotbarQuickAction[]>|HotbarQuickAction[]} [quickActions]
 * @property {(ctx: object) => Promise<HotbarIndicator[]>|HotbarIndicator[]} [indicators]
 */
const hotbarFactionItems = createRegistry();

/** Prefix of the `data-action` of a button that belongs to a provider; the rest is `<provider id>:<key>`. */
export const HOTBAR_EXTENSION_ACTION_PREFIX = 'ext:';

/**
 * @param {HotbarFactionItems} spec
 * @returns {() => void}  Unregister.
 */
export function registerHotbarFactionItems(spec) {
  const id = requireId(spec, 'hotbar faction items');
  if (spec.quickActions === undefined && spec.indicators === undefined) {
    throw new TypeError(`SpaceHolder | integration: hotbar faction items "${id}" give neither quickActions nor indicators`);
  }
  if (spec.quickActions !== undefined) requireFunction(spec.quickActions, 'quickActions', `hotbar faction items "${id}"`);
  if (spec.indicators !== undefined) requireFunction(spec.indicators, 'indicators', `hotbar faction items "${id}"`);
  return hotbarFactionItems.add(id, { id, quickActions: spec.quickActions, indicators: spec.indicators });
}

/**
 * Ask every provider for its buttons and indicators.
 * @param {object} ctx  Passed to the providers (the user, the active faction, ...).
 * @returns {Promise<{quickActions: object[], indicators: object[], handlers: Map<string, Function>}>}
 *          Buttons carry a ready `data-action` in `action`; `handlers` maps it to the provider's `onClick`.
 */
export async function collectHotbarFactionItems(ctx) {
  const quickActions = [];
  const indicators = [];
  const handlers = new Map();

  for (const provider of hotbarFactionItems.list()) {
    if (provider.quickActions) {
      try {
        for (const item of (await provider.quickActions(ctx)) ?? []) {
          if (!item?.key || !item.icon || !item.label) continue;
          const action = `${HOTBAR_EXTENSION_ACTION_PREFIX}${provider.id}:${item.key}`;
          quickActions.push({
            key: `${provider.id}:${item.key}`,
            action,
            icon: String(item.icon),
            label: String(item.label),
            disabled: Boolean(item.disabled),
            active: Boolean(item.active),
          });
          if (typeof item.onClick === 'function') handlers.set(action, item.onClick);
        }
      } catch (err) {
        logProviderError('hotbar quick actions', provider.id, err);
      }
    }
    if (provider.indicators) {
      try {
        for (const item of (await provider.indicators(ctx)) ?? []) {
          const text = String(item?.text ?? '').trim();
          if (!item?.key || !text) continue;
          indicators.push({ key: `${provider.id}:${item.key}`, text, tooltip: String(item.tooltip ?? '') });
        }
      } catch (err) {
        logProviderError('hotbar indicators', provider.id, err);
      }
    }
  }

  return { quickActions, indicators, handlers };
}

// ---------------------------------------------------------------------------
// Journals that belong to a package, not to the journal workflow
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ServiceJournalPredicate
 * @property {string} id
 * @property {(doc: JournalEntry|JournalEntryPage|Folder) => boolean} test
 *           True for a journal entry, page or folder the package keeps for itself (timeline, events, ...):
 *           the journal-check workflow skips it and the journal directory hides it.
 */
const serviceJournalPredicates = createRegistry();
/** Marker name → how many registrations hold it (two packages may name the same marker). */
const journalOperationMarkers = new Map();

/**
 * @param {ServiceJournalPredicate} spec
 * @returns {() => void}  Unregister.
 */
export function registerServiceJournalPredicate(spec) {
  const id = requireId(spec, 'a service journal predicate');
  requireFunction(spec.test, 'test', `service journal predicate "${id}"`);
  return serviceJournalPredicates.add(id, { id, test: spec.test });
}

function claimedByPackage(doc) {
  for (const predicate of serviceJournalPredicates.list()) {
    try {
      if (predicate.test(doc)) return true;
    } catch (err) {
      logProviderError('service journal predicate', predicate.id, err);
    }
  }
  return false;
}

/**
 * @param {JournalEntry|JournalEntryPage|Folder|null|undefined} doc
 * @returns {boolean}  Whether any package claims the document as its own; a page also counts when its entry is claimed.
 */
export function isServiceJournal(doc) {
  if (!doc) return false;
  if (claimedByPackage(doc)) return true;
  return doc.documentName === 'JournalEntryPage' && Boolean(doc.parent) && claimedByPackage(doc.parent);
}

/**
 * Name an operation option that marks a journal change as the package's own (like `{ pkgJournalCheck: true }`);
 * the journal-check workflow then leaves such changes alone.
 * @param {string} key
 * @returns {() => void}  Unregister.
 */
export function registerJournalOperationMarker(key) {
  const name = typeof key === 'string' ? key.trim() : '';
  if (!name) throw new TypeError('SpaceHolder | integration: a journal operation marker needs a non-empty name');
  journalOperationMarkers.set(name, (journalOperationMarkers.get(name) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const left = (journalOperationMarkers.get(name) ?? 0) - 1;
    if (left > 0) journalOperationMarkers.set(name, left);
    else journalOperationMarkers.delete(name);
  };
}

/**
 * @param {object|null|undefined} options  Options of a document operation.
 * @returns {boolean}
 */
export function isRegisteredJournalOperation(options) {
  if (!options || typeof options !== 'object') return false;
  for (const name of journalOperationMarkers.keys()) if (options[name]) return true;
  return false;
}

/**
 * The object published as `game.spaceholder.integration`: everything a package may use, in one place.
 * @param {object} hooks  What only the running system can do.
 * @param {() => void} hooks.requestHotbarFactionRender
 * @param {(page: JournalEntryPage) => string} hooks.getJournalPageStatus
 * @param {() => InfluenceManager|null|undefined} hooks.getInfluenceManager
 */
export function createIntegrationApi({ requestHotbarFactionRender, getJournalPageStatus, getInfluenceManager }) {
  return {
    apiVersion: INTEGRATION_API_VERSION,
    hiddenActorTypes,
    tokenPointerOffTypes,
    registerFactionSheetSection,
    registerHotbarFactionItems,
    requestHotbarFactionRender: () => requestHotbarFactionRender(),
    registerServiceJournalPredicate,
    registerJournalOperationMarker,
    getJournalPageStatus: (page) => getJournalPageStatus(page),
    setInfluenceSourceProvider: (provider) => getInfluenceManager()?.setSourceProvider(provider),
    requestInfluenceRedraw: (opts = {}) => getInfluenceManager()?.requestRedraw(opts),
  };
}

/** Empty every registry and type set (tests). */
export function resetIntegrationRegistry() {
  factionSheetSections.clear();
  hotbarFactionItems.clear();
  serviceJournalPredicates.clear();
  journalOperationMarkers.clear();
  hiddenActorTypes.clear();
  tokenPointerOffTypes.clear();
}
