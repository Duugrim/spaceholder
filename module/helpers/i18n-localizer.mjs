/**
 * A localizer the pure helpers take instead of reaching for `game.i18n`, so their texts can be tested in plain
 * Node against `lang/*.json`: `t(key, fallback)` localizes, `f(key, data, fallback)` localizes and fills
 * `{placeholders}`. A key that is not found gives the fallback.
 */

/**
 * The default localizer: Foundry's `game.i18n`.
 * @returns {{ t: (key: string, fallback?: string) => string, f: (key: string, data: object, fallback?: string) => string }}
 */
export function foundryLocalizer() {
  return {
    t(key, fallback = '') {
      const value = globalThis.game?.i18n?.localize?.(key);
      return value && value !== key ? value : fallback;
    },
    f(key, data, fallback = '') {
      const value = globalThis.game?.i18n?.format?.(key, data);
      return value && value !== key ? value : fallback;
    },
  };
}
