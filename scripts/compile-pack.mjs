/**
 * Build a LevelDB compendium from pack-src/<name>.
 * Default output: packs/<name>-next (avoids LOCK while Foundry is open).
 * Usage: node scripts/compile-pack.mjs <name> [--in-place]
 *   --in-place  write to packs/<name> (close Foundry first)
 */
import { compilePack } from '@foundryvtt/foundryvtt-cli';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const name = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!name) {
  console.error('Usage: node scripts/compile-pack.mjs <pack-name> [--in-place]');
  process.exit(1);
}
const src = path.join(root, 'pack-src', name);
if (!fs.existsSync(src)) {
  console.error(`No sources: ${src}`);
  process.exit(1);
}
const inPlace = process.argv.includes('--in-place');
const dest = path.join(root, 'packs', inPlace ? name : `${name}-next`);

await compilePack(src, dest, { log: true });
console.log(`Done: ${dest}`);
