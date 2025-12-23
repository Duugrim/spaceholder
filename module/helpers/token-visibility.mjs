import { normalizeUuid, getUsersForToken } from './user-factions.mjs';

const MODULE_NS = 'spaceholder';

let _hooksInstalled = false;
let _dirtySources = true;
let _cachedSceneId = null;
let _cachedSources = [];
let _updateAllTimeout = null;

/**
 * Установить хуки для продвинутой видимости токенов.
 * Важно: логика применяется только к токенам, у которых actor.type === 'globalobject'.
 */
export function installTokenVisibilityHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  Hooks.on('canvasReady', () => {
    _markSourcesDirty('canvasReady');
    _scheduleUpdateAllTokens({ reason: 'canvasReady', delayMs: 0 });
  });

  // Применяем маску поверх видимости Foundry при каждом refresh.
  // Важно: НЕ затираем «базовую» видимость Foundry в момент, когда токен уже скрыт нашей маской.
  Hooks.on('refreshToken', (token) => {
    try {
      if (!token) return;
      _applyTokenVisibility(token, { captureFoundryBase: true });
    } catch (e) {
      console.error('SpaceHolder | TokenVisibility: refreshToken handler failed', e);
    }
  });

  // Движение/создание/удаление источников влияния меняет результат для всех.
  Hooks.on('createToken', (tokenDoc) => {
    if (!_isGlobalObjectTokenDoc(tokenDoc)) return;
    _markSourcesDirty('createToken');
    _scheduleUpdateAllTokens({ reason: 'createToken' });
  });

  Hooks.on('deleteToken', (tokenDoc) => {
    if (!_isGlobalObjectTokenDoc(tokenDoc)) return;
    _markSourcesDirty('deleteToken');
    _scheduleUpdateAllTokens({ reason: 'deleteToken' });
  });

  Hooks.on('updateToken', (tokenDoc, change /*, options, userId */) => {
    if (!_isGlobalObjectTokenDoc(tokenDoc)) return;

    // Оптимизация: реагируем только на изменения, которые могут влиять на попадание в зоны.
    if (!_isTokenSpatialChange(change)) return;

    _markSourcesDirty('updateToken');
    _scheduleUpdateAllTokens({ reason: 'updateToken' });
  });

  // Изменение gRange/gFaction или режима видимости — пересчёт.
  Hooks.on('updateActor', (actor, change) => {
    if (!actor || actor.type !== 'globalobject') return;
    if (!_isGlobalObjectRelevantActorChange(change)) return;

    // gRange/gFaction влияет и на источники.
    _markSourcesDirty('updateActor');
    _scheduleUpdateAllTokens({ reason: 'updateActor' });
  });

  // Если меняются фракции пользователя, fullHidden может поменяться.
  Hooks.on('updateUser', (user, change) => {
    if (!_isUserFactionsChange(change)) return;
    _scheduleUpdateAllTokens({ reason: 'updateUser' });
  });
}

function _scheduleUpdateAllTokens({ reason = 'unknown', delayMs = 50 } = {}) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (_updateAllTimeout) {
    try { clearTimeout(_updateAllTimeout); } catch (e) { /* ignore */ }
  }

  _updateAllTimeout = setTimeout(() => {
    _updateAllTimeout = null;
    try {
      _updateAllTokensNow({ reason });
    } catch (e) {
      console.error('SpaceHolder | TokenVisibility: updateAll failed', e);
    }
  }, ms);
}

function _updateAllTokensNow({ reason = 'unknown' } = {}) {
  const tokens = canvas?.tokens?.placeables;
  if (!tokens || !Array.isArray(tokens)) return;

  // Ленивая актуализация кэша зон.
  _getInfluenceSources();

  for (const token of tokens) {
    try {
      _applyTokenVisibility(token, { captureFoundryBase: false });
    } catch (e) {
      console.warn('SpaceHolder | TokenVisibility: failed to apply for token', token?.id, e);
    }
  }

}

function _markSourcesDirty(/* reason */) {
  _dirtySources = true;
}

function _getInfluenceSources() {
  const sceneId = canvas?.scene?.id ?? null;
  if (!sceneId) {
    _cachedSceneId = null;
    _cachedSources = [];
    _dirtySources = false;
    return _cachedSources;
  }

  if (_cachedSceneId !== sceneId) {
    _cachedSceneId = sceneId;
    _dirtySources = true;
  }

  if (!_dirtySources) return _cachedSources;

  _cachedSources = _computeInfluenceSources();
  _dirtySources = false;
  return _cachedSources;
}

function _computeInfluenceSources() {
  const im = game?.spaceholder?.influenceManager;
  if (!im || typeof im.collectGlobalObjects !== 'function') return [];

  let objects = [];
  try {
    objects = im.collectGlobalObjects();
  } catch (e) {
    console.error('SpaceHolder | TokenVisibility: influenceManager.collectGlobalObjects failed', e);
    return [];
  }

  const sources = [];

  for (const o of objects) {
    if (!o) continue;
    const tokenDoc = o.token;
    const actor = tokenDoc?.actor;

    if (!actor || actor.type !== 'globalobject') continue;

    const gRange = Number(o.gRange ?? 0) || 0;
    if (gRange <= 0) continue;

    const gRangeSq = Number(o.gRangeSq ?? 0) || (gRange * gRange);
    const pos = o.position;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;

    const faction = normalizeUuid(actor.system?.gFaction);

    // Для fullHidden нужно знать, какие пользователи «владельцы» этой зоны.
    const userIds = new Set();
    try {
      const users = getUsersForToken(tokenDoc);
      for (const u of users) {
        if (u?.id) userIds.add(u.id);
      }
    } catch (e) {
      // ignore
    }

    sources.push({
      tokenDoc,
      tokenId: tokenDoc.id,
      faction,
      pos: { x: pos.x, y: pos.y },
      rangeSq: gRangeSq,
      userIds,
    });
  }

  return sources;
}

function _applyTokenVisibility(token, { captureFoundryBase = false } = {}) {
  if (!token?.document) return;

  const actor = token.document.actor;
  if (!actor || actor.type !== 'globalobject') return;

  const user = game?.user;
  if (!user) return;

  const mode = _normalizeVisibilityMode(actor.getFlag?.(MODULE_NS, 'tokenVisibility') ?? actor.flags?.[MODULE_NS]?.tokenVisibility);

  // Обновляем кэш «базовой» видимости Foundry только когда:
  // - нас явно попросили (обычно из refreshToken)
  // - и маска НЕ активна (чтобы не записать в базу уже «задушенную» видимость)
  // - или режим public (мы не должны вмешиваться)
  const maskWasApplied = Boolean(token._spaceholderMaskApplied);
  if (captureFoundryBase && (!maskWasApplied || mode === 'public')) {
    token._spaceholderFoundryVisible = token.visible;
    token._spaceholderFoundryRenderable = token.renderable;
  }

  // public: не ограничиваем, но если раньше прятали — вернём к базовому значению.
  if (mode === 'public') {
    token._spaceholderMaskApplied = false;

    const v = token._spaceholderFoundryVisible;
    const r = token._spaceholderFoundryRenderable;

    if (typeof v === 'boolean' && token.visible !== v) token.visible = v;
    if (typeof r === 'boolean' && 'renderable' in token && token.renderable !== r) token.renderable = r;
    return;
  }

  const allow = _shouldUserSeeToken({ token, actor, user, mode });

  // Для halfHidden/fullHidden/secret мы применяем маску напрямую.
  // При необходимости «базовую» видимость Foundry можно будет вернуть, переключив режим обратно на public.
  const finalVisible = Boolean(allow);
  const finalRenderable = Boolean(allow);

  token._spaceholderMaskApplied = true;

  if (token.visible !== finalVisible) token.visible = finalVisible;
  if ('renderable' in token && token.renderable !== finalRenderable) token.renderable = finalRenderable;
}

function _shouldUserSeeToken({ token, actor, user, mode }) {
  if (user.isGM) return true;

  // Владельцы/наблюдатели всегда видят свои токены.
  try {
    if (typeof actor.testUserPermission === 'function' && actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)) {
      return true;
    }
  } catch (e) {
    // ignore
  }

  // Режим приходит сверху, чтобы не вычислять повторно.
  if (mode === 'public') return true;
  if (mode === 'secret') return false;

  // halfHidden/fullHidden требуют наличия источников влияния.
  const sources = _getInfluenceSources();
  if (!sources.length) return false;

  const center = _getTokenCenter(token);
  if (!center) return false;

  if (mode === 'halfHidden') {
    const tokenFaction = normalizeUuid(actor.system?.gFaction);

    // Видим, если попали в зону хотя бы одной «чужой» фракции.
    for (const s of sources) {
      if (!_pointInSource(center, s)) continue;
      if (s.faction !== tokenFaction) return true;
    }
    return false;
  }

  if (mode === 'fullHidden') {
    const userId = user.id;
    if (!userId) return false;

    // Видим, если пользователь принадлежит хотя бы одной зоне, в которой стоит токен.
    for (const s of sources) {
      if (!_pointInSource(center, s)) continue;
      if (s.userIds?.has(userId)) return true;
    }
    return false;
  }

  // Неизвестное значение — не ограничиваем.
  return true;
}

function _normalizeVisibilityMode(raw) {
  const mode = String(raw ?? '').trim();
  if (!mode) return 'public';
  if (mode === 'hidden') return 'halfHidden'; // legacy fallback
  if (mode === 'public' || mode === 'halfHidden' || mode === 'fullHidden' || mode === 'secret') return mode;
  return 'public';
}

function _pointInSource(pt, source) {
  const dx = pt.x - source.pos.x;
  const dy = pt.y - source.pos.y;
  return (dx * dx + dy * dy) <= (Number(source.rangeSq) || 0);
}

function _getTokenCenter(token) {
  // Быстрый путь: placeable уже на канвасе.
  const c = token?.center;
  if (c && typeof c.x === 'number' && typeof c.y === 'number') return c;

  // Fallback: по документу.
  const doc = token?.document ?? token;
  return _getTokenDocCenter(doc);
}

function _getTokenDocCenter(tokenDoc, { x = null, y = null } = {}) {
  const gridSize = canvas?.grid?.size || 100;

  const docX = Number(x ?? tokenDoc?.x ?? 0) || 0;
  const docY = Number(y ?? tokenDoc?.y ?? 0) || 0;

  const scaleX = Number(tokenDoc?.texture?.scaleX ?? 1) || 1;
  const scaleY = Number(tokenDoc?.texture?.scaleY ?? 1) || 1;

  const w = (Number(tokenDoc?.width) || 1) * gridSize * scaleX;
  const h = (Number(tokenDoc?.height) || 1) * gridSize * scaleY;

  return { x: docX + (w / 2), y: docY + (h / 2) };
}

function _isGlobalObjectTokenDoc(tokenDoc) {
  return tokenDoc?.actor?.type === 'globalobject';
}

function _isTokenSpatialChange(change) {
  if (!change || typeof change !== 'object') return false;

  // Dotted/flat update format.
  if (Object.prototype.hasOwnProperty.call(change, 'x')) return true;
  if (Object.prototype.hasOwnProperty.call(change, 'y')) return true;
  if (Object.prototype.hasOwnProperty.call(change, 'width')) return true;
  if (Object.prototype.hasOwnProperty.call(change, 'height')) return true;

  // Nested format.
  const tex = change.texture;
  if (tex && typeof tex === 'object') {
    if ('scaleX' in tex || 'scaleY' in tex) return true;
  }

  // Dotted keys.
  for (const k of Object.keys(change)) {
    if (k === 'texture.scaleX' || k === 'texture.scaleY') return true;
  }

  return false;
}

function _isGlobalObjectRelevantActorChange(change) {
  if (!change || typeof change !== 'object') return false;

  // Вложенная форма.
  const sys = change.system;
  if (sys && typeof sys === 'object') {
    if ('gRange' in sys || 'gFaction' in sys) return true;
  }

  const flags = change.flags;
  if (flags && typeof flags === 'object') {
    const sh = flags.spaceholder;
    if (sh && typeof sh === 'object') {
      if ('tokenVisibility' in sh) return true;
    }
  }

  // Dotted форма.
  for (const k of Object.keys(change)) {
    if (k === 'system.gRange' || k === 'system.gFaction') return true;
    if (k === 'flags.spaceholder.tokenVisibility') return true;
    if (k.startsWith('system.gRange') || k.startsWith('system.gFaction')) return true;
    if (k.startsWith('flags.spaceholder.tokenVisibility')) return true;
  }

  return false;
}

function _isUserFactionsChange(change) {
  if (!change || typeof change !== 'object') return false;

  const flags = change.flags;
  if (flags && typeof flags === 'object') {
    const sh = flags.spaceholder;
    if (sh && typeof sh === 'object') {
      if ('factions' in sh) return true;
    }
  }

  for (const k of Object.keys(change)) {
    if (k === 'flags.spaceholder.factions') return true;
    if (k.startsWith('flags.spaceholder.factions')) return true;
  }

  return false;
}
