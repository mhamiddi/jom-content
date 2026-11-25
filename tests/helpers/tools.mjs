// Dev-only test tools (playwright-core, miniflare) resolve from the repo's own
// devDependencies (`npm install` at the repo root). THREADS_TEST_TOOLS can point at
// another package.json that has them. Chromium comes from CHROMIUM_PATH or the
// first known local install.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const toolsRequire = createRequire(process.env.THREADS_TEST_TOOLS || new URL('../../package.json', import.meta.url));

export function chromePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [join(homedir(), '.hermes/tools'), join(homedir(), '.cache/ms-playwright')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const bin = join(root, d, 'chrome-linux64/chrome');
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH.');
}
