/**
 * Define a set of template paths to pre-load
 * Pre-loaded templates are compiled and cached for fast access when rendering
 */
export const preloadHandlebarsTemplates = async function () {
  return foundry.applications.handlebars.loadTemplates([
    // Actor partials.
    'systems/spaceholder/templates/actor/parts/actor-features.hbs',
    'systems/spaceholder/templates/actor/parts/actor-items.hbs',
    'systems/spaceholder/templates/actor/parts/actor-loot-items.hbs',
    'systems/spaceholder/templates/actor/parts/actor-spells.hbs',
    'systems/spaceholder/templates/actor/parts/actor-health.hbs',
    'systems/spaceholder/templates/actor/parts/actor-injuries.hbs',
    'systems/spaceholder/templates/actor/parts/actor-inventory.hbs',
    'systems/spaceholder/templates/actor/parts/actor-effects.hbs',
    'systems/spaceholder/templates/actor/parts/actor-actions.hbs',
    'systems/spaceholder/templates/actor/parts/actor-action-dialog.hbs',
    'systems/spaceholder/templates/actor/parts/actor-held-items.hbs',
    'systems/spaceholder/templates/actor/parts/actor-aiming-arc.hbs',
    'systems/spaceholder/templates/actor/parts/actor-stats-derived-physical-resources.hbs',
    'systems/spaceholder/templates/actor/parts/actor-stats-derived-coordination-mental.hbs',
    'systems/spaceholder/templates/actor/parts/actor-character-header.hbs',
    'systems/spaceholder/templates/partials/sh-tab-banner.hbs',
    // Item partials
    'systems/spaceholder/templates/item/parts/item-sheet-header.hbs',
    'systems/spaceholder/templates/item/parts/item-description-prosemirror.hbs',
    'systems/spaceholder/templates/item/parts/item-effects.hbs',
    'systems/spaceholder/templates/item/parts/item-actions.hbs',
    'systems/spaceholder/templates/item/parts/item-action-dialog.hbs',
    'systems/spaceholder/templates/item/parts/item-weapon-channel-tab.hbs',
    'systems/spaceholder/templates/item/parts/item-weapon-ammo-tab.hbs',
    'systems/spaceholder/templates/item/parts/item-weapon-attack-dialog.hbs',
    'systems/spaceholder/templates/item/parts/item-weapon-base-dialog.hbs',
    'systems/spaceholder/templates/item/parts/item-weapon-channel-options-dialog.hbs',
    'systems/spaceholder/templates/item/parts/item-weapon-ammo-dialog.hbs',
    // Icon picker (ApplicationV2)
    'systems/spaceholder/templates/icon-picker/icon-picker.hbs',
    // HUD: Hotbar faction selector
    'systems/spaceholder/templates/hud/hotbar-faction-ui.hbs',
  ]);
};
