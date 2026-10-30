import * as fs from 'fs';
import * as path from 'path';
import { buildReport, comparePng, findFramePairs } from './measure.js';
import type { FrameDiff } from './measure.js';
import { FIGMA_DIFF_DIR } from './paths.js';
import { playwrightRunner, pngSize } from './render.js';
import type { RenderRunner } from './render.js';

/**
 * The measurement of the prototype against the Figma screenshots.
 *
 * This is the module the graph and the worker both call: the worker uses it
 * to iterate on the prototype, the graph uses it to produce the report that
 * goes into the requirement documents.
 */

/** How a measurement runs. */
export interface FidelityOptions {
  /** The requirement directory of the run. */
  docsDir: string;
  /** The repository of the run - the browser comes from there. */
  repoDir: string;
  /** The renderer. The default is the Playwright of the repository. */
  runner?: RenderRunner;
}

/** The outcome of a measurement. */
export interface FidelityReport {
  /** The measurement of every frame. */
  frames: FrameDiff[];
  /** How many frames could not be measured at all. */
  hardFailures: number;
  /** The machine readable report. */
  jsonPath: string;
  /** The human readable report. */
  mdPath: string;
}

/**
 * Measure the prototype against the Figma screenshots.
 *
 * A frame that cannot be measured - no prototype page, a page that does not
 * render, a screenshot of a different size - is a **hard failure**: the
 * prototype and the design could not be compared, and nobody may say the
 * prototype matches the design. A frame that was measured but differs a
 * little is `ok` with a ratio: the ratio is a hint, not a verdict.
 *
 * @param opts - Where the artefacts are and how to render.
 * @returns The measurement of every frame.
 */
export async function measureFidelity(opts: FidelityOptions): Promise<FidelityReport> {
  const { docsDir, repoDir } = opts;
  const runner = opts.runner ?? playwrightRunner();

  const diffDir = path.join(docsDir, FIGMA_DIFF_DIR);
  const renderDir = path.join(diffDir, 'render');
  fs.mkdirSync(renderDir, { recursive: true });

  const { pairs, missingHtml } = findFramePairs(docsDir);
  const frames: FrameDiff[] = [];

  for (const key of missingHtml) {
    frames.push({ key, status: 'missing_html', ratio: 0, width: 0, height: 0 });
  }

  for (const pair of pairs) {
    frames.push(await measureFrame(pair, { runner, renderDir, repoDir }));
  }

  frames.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const report = buildReport(frames);
  const jsonPath = path.join(diffDir, 'frames.json');
  const mdPath = path.join(diffDir, 'report.md');
  fs.writeFileSync(jsonPath, `${report.json}\n`, 'utf-8');
  fs.writeFileSync(mdPath, report.md, 'utf-8');

  return {
    frames,
    hardFailures: frames.filter((frame) => frame.status !== 'ok').length,
    jsonPath,
    mdPath,
  };
}

/** Measure one frame. */
async function measureFrame(
  pair: { key: string; screenshot: string; html: string },
  ctx: { runner: RenderRunner; renderDir: string; repoDir: string }
): Promise<FrameDiff> {
  const { key, screenshot, html } = pair;
  const fail = (
    status: FrameDiff['status'],
    error: string,
    errorKind?: FrameDiff['errorKind']
  ): FrameDiff => ({
    key,
    status,
    ratio: 0,
    width: 0,
    height: 0,
    error,
    ...(errorKind !== undefined ? { errorKind } : {}),
  });

  let width: number;
  let height: number;
  try {
    ({ width, height } = pngSize(screenshot));
  } catch (err) {
    return fail('diff_failed', messageOf(err));
  }

  const renderPath = path.join(ctx.renderDir, `${key}.png`);
  const rendered = await ctx.runner({
    html,
    out: renderPath,
    width,
    height,
    cwd: ctx.repoDir,
  });
  if (!rendered.ok) {
    return fail(
      'render_failed',
      rendered.error ?? 'the prototype page did not render',
      rendered.kind
    );
  }

  let renderWidth: number;
  let renderHeight: number;
  try {
    ({ width: renderWidth, height: renderHeight } = pngSize(renderPath));
  } catch (err) {
    return fail('diff_failed', messageOf(err));
  }

  if (renderWidth !== width || renderHeight !== height) {
    return {
      key,
      status: 'size_mismatch',
      ratio: 0,
      width,
      height,
      error:
        `the rendered page is ${renderWidth}x${renderHeight} but the screenshot is ` +
        `${width}x${height}`,
    };
  }

  try {
    const compared = comparePng(fs.readFileSync(screenshot), fs.readFileSync(renderPath));
    fs.writeFileSync(path.join(path.dirname(ctx.renderDir), `${key}.diff.png`), compared.diff);
    return { key, status: 'ok', ratio: compared.ratio, width, height };
  } catch (err) {
    return fail('diff_failed', messageOf(err));
  }
}

/** The message of an error. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
