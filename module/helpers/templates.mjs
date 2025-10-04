/**
 * Define a set of template paths to pre-load
 * Pre-loaded templates are compiled and cached for fast access when rendering
 */
export const preloadHandlebarsTemplates = async function () {
  return foundry.applications.handlebars.loadTemplates([
    // Actor partials.
    'systems/spaceholder/templates/actor/parts/actor-features.hbs',
    'systems/spaceholder/templates/actor/parts/actor-items.hbs',
    'systems/spaceholder/templates/actor/parts/actor-spells.hbs',
    'systems/spaceholder/templates/actor/parts/actor-health.hbs',
    'systems/spaceholder/templates/actor/parts/actor-injuries.hbs',
    'systems/spaceholder/templates/actor/parts/actor-effects.hbs',
    // Item partials
    'systems/spaceholder/templates/item/parts/item-effects.hbs',
  ]);
};
