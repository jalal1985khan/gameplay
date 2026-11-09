// Copies the stats and strategy modules into the app, so the dashboard and the standalone
// app run the exact same tested statistics and strategy rules.
// If ../stats.js or ../strategy.js exist in the parent folder, they are synced.
// If deployed independently (e.g. standalone Vercel / Docker build), the bundled copies are preserved.
import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'lib/shared'), {recursive: true});

const files = [
  ['../stats.js', 'lib/shared/stats.cjs'],
  ['../strategy.js', 'lib/shared/strategy.cjs'],
];

for (const [srcRel, dstRel] of files) {
  const src = join(root, srcRel);
  const dst = join(root, dstRel);
  if (existsSync(src)) {
    copyFileSync(src, dst);
    console.log(`synced ${srcRel} -> ${dstRel}`);
  } else if (existsSync(dst)) {
    console.log(`using bundled ${dstRel} (parent file not present)`);
  } else {
    console.error(`missing required file: ${dstRel}`);
    process.exit(1);
  }
}
