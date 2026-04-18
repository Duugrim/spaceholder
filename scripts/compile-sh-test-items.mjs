/**
 * Build LevelDB compendium from pack-src/sh-test-items.
 * Default output: packs/sh-test-items-next (avoids LOCK while Foundry is open).
 * Usage: node scripts/compile-sh-test-items.mjs [--in-place]
 *   --in-place  write to packs/sh-test-items (close Foundry first)
 */
import { compilePack } from '@foundryvtt/foundryvtt-cli';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'pack-src', 'sh-test-items');
const inPlace = process.argv.includes('--in-place');
const dest = path.join(root, 'packs', inPlace ? 'sh-test-items' : 'sh-test-items-next');

await compilePack(src, dest, { log: true });
console.log(`Done: ${dest}`);
