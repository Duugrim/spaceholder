// node module/helpers/integration-templates.test.mjs
// The faction sheet and the hotbar faction block render what integrating packages add to them.
// Uses the Handlebars that ships with Foundry; skipped when Foundry is not installed (FOUNDRY_APP_DIR overrides the path).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appDir = process.env.FOUNDRY_APP_DIR ?? 'E:/Foundry14/Foundry Virtual Tabletop/resources/app';

let Handlebars;
try {
  Handlebars = createRequire(path.join(appDir, 'package.json'))('handlebars');
} catch (err) {
  console.log(`integration-templates.test.mjs: skipped (Handlebars not found in ${appDir})`);
  process.exit(0);
}
Handlebars.registerHelper('localize', (key) => `«${key}»`);

const render = (rel, context) => Handlebars.compile(fs.readFileSync(path.join(root, rel), 'utf8'))(context);

// ---- faction sheet ----
const FACTION = 'templates/actor/actor-faction-sheet.hbs';
const factionContext = { actor: { name: 'Red', img: 'x.svg', type: 'faction' }, system: { fColor: '#cc3333', fLink: '' }, editable: true };

let html = render(FACTION, factionContext);
assert.ok(!html.includes('data-faction-section'), 'no sections: nothing is added');

html = render(FACTION, { ...factionContext, extraSections: [{ id: 'azimuth-pp', html: '<div class="pkg-pp"><input name="flags.azimuth.pp.modifier"></div>' }, { id: 'other', html: '<p>Other</p>' }] });
assert.ok(html.includes('data-faction-section="azimuth-pp"'), 'the section has its own element');
assert.ok(html.includes('<div class="pkg-pp"><input name="flags.azimuth.pp.modifier"></div>'), 'the markup is inserted as markup, not escaped');
assert.ok(html.includes('data-faction-section="other"'));
assert.ok(html.indexOf('data-faction-section="azimuth-pp"') < html.indexOf('data-faction-section="other"'), 'in registration order');
const formOpen = html.indexOf('<form');
const formClose = html.indexOf('</form>');
assert.ok(formOpen < html.indexOf('data-faction-section="azimuth-pp"') && html.indexOf('data-faction-section="other"') < formClose, 'the sections are inside the form, so their inputs are saved with the sheet');

// ---- hotbar faction block ----
const HOTBAR = 'templates/hud/hotbar-faction-ui.hbs';
const hotbarContext = {
  toggleLabel: 'Red',
  active: { uuid: 'Actor.f', name: 'Red', img: 'r.svg' },
  choices: [],
  canToggle: false,
  quickActions: [{ key: 'journal-log', action: 'open-journal-update-log', icon: 'fa-solid fa-book', label: 'Journal log', disabled: false, active: false }],
};

html = render(HOTBAR, hotbarContext);
assert.ok(html.includes('data-action="open-journal-update-log"'));
assert.ok(!html.includes('sh-hotbar-faction__pp'), 'no indicators, no counter');

html = render(HOTBAR, {
  ...hotbarContext,
  quickActions: [...hotbarContext.quickActions, { key: 'azimuth:events', action: 'ext:azimuth:events', icon: 'fa-solid fa-bolt', label: 'Events', disabled: false, active: true }],
  indicators: [{ key: 'azimuth:pp', text: '3/20', tooltip: 'Progression points' }],
});
assert.ok(html.includes('data-action="ext:azimuth:events"'), 'a package button is drawn like the others');
assert.ok(/data-action="ext:azimuth:events"[\s\S]*?aria-pressed="true"/.test(html) || html.includes('is-active'), 'its active state shows');
assert.ok(html.includes('>3/20</div>'), 'the indicator text is drawn');
assert.ok(html.includes('data-tooltip="Progression points"'));

html = render(HOTBAR, { ...hotbarContext, indicators: [{ key: 'a:b', text: '5', tooltip: 't' }, { key: 'c:d', text: '6', tooltip: 'u' }] });
assert.equal((html.match(/sh-hotbar-faction__pp/g) ?? []).length, 2, 'indicators of several packages sit together');

console.log('integration-templates.test.mjs: ok');
