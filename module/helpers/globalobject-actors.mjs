const MODULE_NS = 'spaceholder';

let _hooksInstalled = false;
let _pendingTakeOut = null;

function _normalizeUuid(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  const match = str.match(/@UUID\[(.+?)\]/);
  return String(match?.[1] ?? str).trim();
}

function _extractActorIdFromUuid(uuid) {
  const u = _normalizeUuid(uuid);
  if (!u) return '';

  // World UUID
  // Actor.<id>
  let m = u.match(/^Actor\.([^\.]+)$/);
  if (m?.[1]) return m[1];

  // Compendium UUID ends with .Actor.<id>
  m = u.match(/\.Actor\.([^\.]+)$/);
  if (m?.[1]) return m[1];

  return '';
}

async function _removeFromGlobalObjectContainer({ sourceGlobalObjectUuid, actorUuid }) {
  const srcUuid = _normalizeUuid(sourceGlobalObjectUuid);
  const aUuid = _normalizeUuid(actorUuid);
  if (!srcUuid || !aUuid) return;

  let src = null;
  try {
    src = await fromUuid(srcUuid);
  } catch (e) {
    src = null;
  }

  if (!src || src.documentName !== 'Actor') return;
  if (src.type !== 'globalobject') return;

  const current = Array.isArray(src.system?.gActors)
    ? foundry.utils.deepClone(src.system.gActors)
    : [];

  const next = current.filter((u) => _normalizeUuid(u) !== aUuid);
  if (next.length === current.length) return;

  await src.update({ 'system.gActors': next });
}

export function installGlobalObjectActorContainerHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  // When an actor is dropped onto the canvas, we can capture the drag data.
  Hooks.on('dropCanvasData', (_canvas, data) => {
    try {
      const marker = data?.[MODULE_NS] ?? data?.spaceholder;
      if (marker?.action !== 'globalobject-takeout') return;

      const actorUuid = _normalizeUuid(data?.uuid);
      const sourceGlobalObjectUuid = _normalizeUuid(marker?.sourceGlobalObjectUuid);
      const sceneId = canvas?.scene?.id ?? '';

      if (!actorUuid || !sourceGlobalObjectUuid || !sceneId) return;

      const actorId = _extractActorIdFromUuid(actorUuid);

      const stamp = Date.now();
      _pendingTakeOut = {
        actorUuid,
        actorId,
        sourceGlobalObjectUuid,
        sceneId,
        stamp,
      };

      // Auto-clear in case token creation never happens.
      setTimeout(() => {
        if (_pendingTakeOut?.stamp === stamp) _pendingTakeOut = null;
      }, 4000);
    } catch (e) {
      console.warn('SpaceHolder | GlobalObject take-out: dropCanvasData handler failed', e);
    }
  });

  // After the token is actually created, remove the actor from the container.
  Hooks.on('createToken', (tokenDoc /*, options, userId */) => {
    try {
      const p = _pendingTakeOut;
      if (!p) return;

      // Ensure it is the same scene.
      const tokenSceneId = tokenDoc?.parent?.id ?? tokenDoc?.scene?.id ?? canvas?.scene?.id ?? '';
      if (!tokenSceneId || tokenSceneId !== p.sceneId) return;

      const tokenActorId = String(tokenDoc?.actorId ?? tokenDoc?.actor?.id ?? '').trim();
      const tokenActorUuid = _normalizeUuid(tokenDoc?.actor?.uuid);
      const tokenActorSourceId = _normalizeUuid(tokenDoc?.actor?.sourceId);

      const idMatch = !!p.actorId && !!tokenActorId && (tokenActorId === p.actorId);
      const uuidMatch = !!p.actorUuid && (tokenActorUuid === p.actorUuid || tokenActorSourceId === p.actorUuid);

      if (!idMatch && !uuidMatch) return;

      _pendingTakeOut = null;

      // Do the update asynchronously.
      void _removeFromGlobalObjectContainer({
        sourceGlobalObjectUuid: p.sourceGlobalObjectUuid,
        actorUuid: p.actorUuid,
      });
    } catch (e) {
      console.warn('SpaceHolder | GlobalObject take-out: createToken handler failed', e);
    }
  });
}
