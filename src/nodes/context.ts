import * as fs from 'fs';
import * as path from 'path';
import { FIGMA_PROTOTYPE_DIR, FIGMA_SCREENSHOT_DIR } from '../figma/paths.js';
import type { Task } from '../state/types.js';

/**
 * The files a worker has to read.
 *
 * **The point of this module is to be small.** The developer used to read
 * the whole `tasks.md` (every task of the plan) and the whole design file
 * (the node tree of every frame) on every task. Now it reads the
 * specification, the prototype page of the frames this task implements, their
 * screenshots and the design tokens - and nothing else.
 *
 * A frame that is not on disk (no Figma design, or a frame the task splitter
 * named wrong) is simply left out: a path that does not exist would only
 * confuse the worker.
 */

/**
 * The inputs of a developer work order.
 *
 * @param docsDir - The requirement documents of the run.
 * @param task - The task that is being worked.
 * @returns The absolute paths, in the order the worker should read them.
 */
export function developerInputs(docsDir: string, task: Task): string[] {
  const inputs = [path.join(docsDir, 'spec.md')];

  for (const frame of task.frames ?? []) {
    const page = prototypePage(docsDir, frame);
    if (page !== undefined) inputs.push(page);
    const screenshot = screenshotOf(docsDir, frame);
    if (screenshot !== undefined) inputs.push(screenshot);
  }

  const tokens = path.join(docsDir, FIGMA_PROTOTYPE_DIR, 'css', 'tokens.css');
  if (fs.existsSync(tokens)) inputs.push(tokens);

  return inputs;
}

/**
 * The inputs of a review work order.
 *
 * The reviewer needs the prototype page (that is what the design fidelity is
 * judged against) but not the screenshots and not the tokens: it reads the
 * code, not the design.
 *
 * @param docsDir - The requirement documents of the run.
 * @param task - The task that is being reviewed.
 * @returns The absolute paths, in the order the reviewer should read them.
 */
export function reviewerInputs(docsDir: string, task: Task): string[] {
  const inputs = [path.join(docsDir, 'spec.md')];
  for (const frame of task.frames ?? []) {
    const page = prototypePage(docsDir, frame);
    if (page !== undefined) inputs.push(page);
  }
  return inputs;
}

/** The prototype page of a frame, if it is there. */
function prototypePage(docsDir: string, frame: string): string | undefined {
  const page = path.join(docsDir, FIGMA_PROTOTYPE_DIR, `${frame}.html`);
  return fs.existsSync(page) ? page : undefined;
}

/** The screenshot of a frame, if it is there. */
function screenshotOf(docsDir: string, frame: string): string | undefined {
  const shot = path.join(docsDir, FIGMA_SCREENSHOT_DIR, `${frame}.png`);
  return fs.existsSync(shot) ? shot : undefined;
}
