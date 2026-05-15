/**
 * v14: ActiveEffect changes live under `system.changes` via ActiveEffectTypeDataModel.
 * If CONFIG.ActiveEffect.dataModels has no entry for an effect's `type`, `system` may not
 * initialize and core `applyActiveEffects` can throw (e.g. setting `initial` on undefined).
 */
export function registerSpaceholderActiveEffectModels() {
  const Model = foundry.data?.ActiveEffectTypeDataModel;
  if (!Model) {
    console.warn('SpaceHolder | foundry.data.ActiveEffectTypeDataModel is missing; Active Effects may break.');
    return;
  }
  const next = { ...(CONFIG.ActiveEffect.dataModels ?? {}) };
  const ensure = (key) => {
    if (key === undefined || key === null) return;
    if (next[key] === undefined) next[key] = Model;
  };
  ensure('');
  ensure('base');
  ensure(CONFIG.ActiveEffect.defaultType);
  CONFIG.ActiveEffect.dataModels = next;
}
