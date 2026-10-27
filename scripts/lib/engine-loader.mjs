// scripts/lib/engine-loader.mjs — P-443: two engine variants in one Node
// process. Baseline from git HEAD, patched from the working tree. The
// baseline temp file sits INSIDE js/modules/ so relative imports resolve
// unchanged; it is removed on process exit and gitignored.
import { execSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULES = path.join(ROOT, 'js/modules');
const cleanup = [];
process.on('exit', () => { for (const f of cleanup) { try { rmSync(f, { force: true }); } catch {} } });

export async function loadBaseline(commit = 'HEAD') {
  const src = execSync(`git show ${commit}:js/modules/decoder.js`, { cwd: ROOT });
  await mkdir(MODULES, { recursive: true });
  const dest = path.join(MODULES, '.decoder.baseline.js');
  await writeFile(dest, src);
  cleanup.push(dest);
  return import(pathToFileURL(dest).href + `?t=${Date.now()}`);
}

export async function loadPatched() {
  const src = path.join(MODULES, 'decoder.js');
  return import(pathToFileURL(src).href + `?t=${Date.now()}`);
}

export const ROOT_DIR = ROOT;
