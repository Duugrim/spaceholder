/**
 * The system's half of the link with the Azimuth module (global map, timeline, events, progression points).
 * The module's half is `scripts/integrations/` in the module; see `docs/code/reference/AZIMUTH_INTEGRATION.md`.
 *
 * The system asks the module for what the module owns: where the influence sources are, which journals are the
 * module's own. What belongs to the system's interface (hotbar buttons, a faction-sheet section, hidden or
 * pointer-less actor types) the module adds itself through `game.spaceholder.integration`.
 */

export const AZIMUTH_MODULE_ID = 'azimuth';

/** Version of the module's `game.azimuth` contract this half is written for. */
export const EXPECTED_AZIMUTH_API_VERSION = 1;

/** What the module has to offer for the link to work. */
const REQUIRED_API_FUNCTIONS = [
  'getInfluenceSources',
  'isInfluenceSourceToken',
  'isInfluenceSourceActorChange',
  'isServiceJournal',
];

/** @type {'off'|'linked'|'unsupported'} */
let state = 'off';

/** @returns {'off'|'linked'|'unsupported'} */
export function azimuthLinkState() {
  return state;
}

/**
 * Whether a module API is one this half can talk to.
 * @param {object|null|undefined} api  `game.azimuth`.
 * @returns {boolean}
 */
export function isAzimuthApiSupported(api) {
  return api?.integrationApiVersion === EXPECTED_AZIMUTH_API_VERSION
    && REQUIRED_API_FUNCTIONS.every((name) => typeof api[name] === 'function');
}

/**
 * Connect the system's extension points to the module's API.
 * @param {object} args
 * @param {object} args.api          The module's API.
 * @param {object} args.integration  `game.spaceholder.integration`.
 * @returns {boolean}  Whether the module was connected.
 */
export function connectAzimuth({ api, integration }) {
  if (!isAzimuthApiSupported(api)) return false;

  integration.setInfluenceSourceProvider({
    collect: (ctx) => api.getInfluenceSources(ctx),
    isSourceToken: (tokenDoc) => api.isInfluenceSourceToken(tokenDoc),
    isSourceActorChange: (actor, change) => api.isInfluenceSourceActorChange(actor, change),
  });
  integration.registerServiceJournalPredicate({
    id: AZIMUTH_MODULE_ID,
    test: (doc) => Boolean(api.isServiceJournal(doc)),
  });
  return true;
}

/**
 * Connect to the Azimuth module when it is active. Runs at `setup`: every `init` is done (`game.azimuth` exists),
 * nothing is drawn yet.
 * @returns {boolean}  Whether the module was connected.
 */
export function installAzimuthLink() {
  state = 'off';
  const module = globalThis.game?.modules?.get(AZIMUTH_MODULE_ID);
  if (!module?.active) return false;

  const api = module.api ?? globalThis.game.azimuth;
  if (!connectAzimuth({ api, integration: globalThis.game.spaceholder.integration })) {
    state = 'unsupported';
    console.warn(`SpaceHolder | Azimuth offers no integration API ${EXPECTED_AZIMUTH_API_VERSION}; not connected`);
    return false;
  }
  state = 'linked';
  return true;
}

/**
 * Tell the GM when the module is active but could not be connected.
 * @returns {boolean}  Whether a warning was shown.
 */
export function warnIfAzimuthUnsupported() {
  if (state !== 'unsupported' || !game.user?.isGM) return false;
  ui.notifications?.warn(game.i18n.localize('SPACEHOLDER.Azimuth.Unsupported'), { permanent: true });
  return true;
}
