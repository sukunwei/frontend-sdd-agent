import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the Figma artefacts of a requirement live.
 *
 * The paths are relative to the requirement directory (`docs/<requirement>/`),
 * so that the same names work in the work order, in the report and in the
 * scripts that write them.
 */

/** The screenshots of the Figma frames. */
export const FIGMA_SCREENSHOT_DIR = 'figma/screenshots';

/** The static HTML prototype built from the fetched design. */
export const FIGMA_PROTOTYPE_DIR = 'figma/prototype';

/** The measurements of the prototype against the screenshots. */
export const FIGMA_DIFF_DIR = 'figma/diff';

/**
 * Are the screenshots covered by a prototype page?
 *
 * A screenshot without a page is a frame the prototype does not show: the
 * design and the prototype cannot be compared, and the prototype cannot be
 * called a faithful copy of the design.
 *
 * A requirement without Figma has no screenshots, and that is not a failure.
 *
 * @param docsDir - The requirement directory of the run.
 * @returns `ok` plus the relative paths of the missing pages.
 */
export function checkPrototype(docsDir: string): { ok: boolean; missing: string[] } {
  const shotsDir = path.join(docsDir, FIGMA_SCREENSHOT_DIR);
  const prototypeDir = path.join(docsDir, FIGMA_PROTOTYPE_DIR);

  const missing: string[] = [];
  if (!fs.existsSync(shotsDir)) {
    return { ok: true, missing };
  }

  const keys = fs
    .readdirSync(shotsDir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => name.slice(0, -'.png'.length));

  for (const key of keys) {
    if (!fs.existsSync(path.join(prototypeDir, `${key}.html`))) {
      missing.push(path.posix.join(FIGMA_PROTOTYPE_DIR, `${key}.html`));
    }
  }

  return { ok: missing.length === 0, missing };
}
