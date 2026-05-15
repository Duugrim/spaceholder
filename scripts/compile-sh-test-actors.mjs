/**
 * Build LevelDB compendium from pack-src/sh-test-actors.
 * Default output: packs/sh-test-actors-next (avoids LOCK while Foundry is open).
 * Usage: node scripts/compile-sh-test-actors.mjs [--in-place]
 *   --in-place  write to packs/sh-test-actors (close Foundry first)
 */
import { compilePack } from '@foundryvtt/foundryvtt-cli';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'pack-src', 'sh-test-actors');
const inPlace = process.argv.includes('--in-place');
const dest = path.join(root, 'packs', inPlace ? 'sh-test-actors' : 'sh-test-actors-next');

await compilePack(src, dest, { log: true });
console.log(`Done: ${dest}`);
