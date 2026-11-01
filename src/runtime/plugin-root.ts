import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Single source of truth for the plugin root.
 *
 * The plugin root is found by walking UP from this module's own location until
 * a directory containing `.claude-plugin/plugin.json` shows up. That is
 * layout-independent: it works whether the code runs from `src/runtime/`
 * (tsx) or from `dist/src/runtime/` (compiled), which a fixed
 * `path.resolve(__dirname, '../../..')` does not.
 *
 * This module exists on its own so that `paths.ts` and `run-context.ts` can
 * both ask for the plugin root without importing each other - a direct
 * dependency in both directions would be a cycle.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAX_PARENT_WALK = 6;

/**
 * Resolve the plugin root (the directory holding `.claude-plugin/plugin.json`).
 * @throws Error if no ancestor directory contains the plugin manifest.
 */
export function getPluginRoot(): string {
  let dir = HERE;
  for (let i = 0; i < MAX_PARENT_WALK; i += 1) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('plugin root not found');
}
