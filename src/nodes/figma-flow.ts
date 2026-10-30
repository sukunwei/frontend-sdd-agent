import * as fs from 'fs';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import { isUnfinishedResult } from '../cli/protocol.js';
import { measureFidelity } from '../figma/fidelity.js';
import type { FrameDiff } from '../figma/measure.js';
import type { FidelityReport } from '../figma/fidelity.js';
import {
  checkPrototype,
  FIGMA_DIFF_DIR,
  FIGMA_PROTOTYPE_DIR,
  FIGMA_SCREENSHOT_DIR,
} from '../figma/paths.js';
import { hasStageStep, recordStageStep } from '../graph/state.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import { renderWorkOrder } from '../prompts/loader.js';
import type { TBCItem } from '../state/types.js';
import { recordWorkerQuestion } from './stage-gates.js';

/**
 * The Figma stage of the graph.
 *
 * The stage is a chain of four steps, and every one of them is a work order
 * the **Claude Code session** works:
 *
 * 1. `figma_fetch` —— fetch the P0 files and the screenshots,
 * 2. `figma_prototype` —— build a static HTML prototype out of them,
 * 3. the measurement —— render the prototype and compare it with the
 *    screenshots,
 * 4. `figma_polish` —— fix what could not be measured.
 *
 * **The measurement is the point.** A prototype that reproduces the design
 * proves that the fetched files carry the design; a prototype that does not
 * proves that something is missing. Doing this before the spec is written
 * costs one HTML page; doing it after the implementation costs the whole
 * implementation.
 *
 * The stage lives in one module because two stages use it: the PRD stage
 * fetches the design, and the spec stage can fetch it later (when the user
 * decides to). Both have to end up with the same prototype.
 */

/**
 * The files a Figma fetch has to deliver.
 *
 * They are the P0 of the design context: without them the spec stage has
 * nothing to say about the UI, and without a screenshot there is nothing to
 * compare the implementation against.
 */
export const FIGMA_P0_FILES: ReadonlyArray<string> = [
  'figma/figma-meta.json',
  'figma/design-tree.json',
  'figma/design-tokens.json',
  'figma/design-context.md',
];

/** How many times the prototype may be repaired before the user is asked. */
export const MAX_POLISH_ROUNDS = 2;

/**
 * The share of pixels that may differ before the run says so.
 *
 * **The ratio is a hint, not a verdict.** It never stops the run: a
 * different font alone can push a frame over the line. But a frame that is
 * over it is worth telling the user about, so it becomes a non-blocking TBC
 * and shows up in the summary the `confirm_prd` gate shows.
 */
export const PIXEL_RATIO_THRESHOLD = 0.02;

/**
 * Are the Figma P0 files there?
 *
 * @param docsDir - The requirement documents of the run.
 * @returns `ok` plus the relative paths that are missing.
 */
export function checkFigmaP0(docsDir: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const relative of FIGMA_P0_FILES) {
    if (!fs.existsSync(path.join(docsDir, relative))) {
      missing.push(relative);
    }
  }

  const screenshotDir = path.join(docsDir, FIGMA_SCREENSHOT_DIR);
  const hasScreenshot =
    fs.existsSync(screenshotDir) &&
    fs.readdirSync(screenshotDir).some((file) => file.toLowerCase().endsWith('.png'));
  if (!hasScreenshot) {
    missing.push(`${FIGMA_SCREENSHOT_DIR}/*.png`);
  }

  return { ok: missing.length === 0, missing };
}

/**
 * The work order that fetches the design.
 *
 * The graph never calls Figma itself: the session does, with the MCP tools
 * it already has. The order therefore names the files that have to be
 * written - and the directory the screenshot has to go to, so that the
 * order and its prompt say the same thing.
 *
 * @param docsDir - The requirement documents of the run.
 * @param repoDir - The cloned repository (the working directory of the order).
 * @param figmaUrl - The Figma file the user gave.
 */
export function figmaWorkOrder(
  docsDir: string,
  repoDir: string,
  figmaUrl: string
): InterruptPayload {
  const screenshotDir = path.join(docsDir, FIGMA_SCREENSHOT_DIR);
  const outputs = [
    ...FIGMA_P0_FILES.map((relative) => path.join(docsDir, relative)),
    screenshotDir,
  ];
  const context = [
    '',
    '## The Figma file of this run',
    '',
    figmaUrl,
    '',
    'Write the P0 files to the absolute paths listed in `outputs`. The last entry of',
    `\`outputs\` is the screenshot directory: put one png per frame into`,
    `${screenshotDir} (the name of the file is the frame key).`,
    '',
  ].join('\n');

  const body = renderWorkOrder('figma-fetch', {
    goal: '抓取這次需求的 Figma P0 資源：設計檔 metadata、設計節點樹、design token、設計說明與截圖。',
    cwd: repoDir,
    inputs: [],
    outputs,
    outputFormat:
      '`figma-meta.json`（設計檔 metadata）、`design-tree.json`（設計節點樹）、' +
      '`design-tokens.json`（design token）、`design-context.md`（給實作者看的設計說明），' +
      '以及每個主要畫面一張 png 截圖。',
  });

  return {
    audience: 'host',
    type: 'work_order',
    role: 'figma_fetch',
    prompt: `${body}\n${context}`,
    cwd: repoDir,
    inputs: [],
    outputs,
    resultSchema: 'none',
  };
}

/**
 * The work order that builds the HTML prototype.
 *
 * @param docsDir - The requirement documents of the run.
 * @param repoDir - The cloned repository (the working directory of the order).
 */
export function figmaPrototypeWorkOrder(docsDir: string, repoDir: string): InterruptPayload {
  const prototypeDir = path.join(docsDir, FIGMA_PROTOTYPE_DIR);
  const outputs = [path.join(prototypeDir, 'index.html'), prototypeDir];
  const inputs = [
    ...FIGMA_P0_FILES.map((relative) => path.join(docsDir, relative)),
    path.join(docsDir, FIGMA_SCREENSHOT_DIR),
  ];

  const body = renderWorkOrder('figma-prototype', {
    goal:
      '把這次需求的 Figma 畫面做成獨立的靜態 HTML 原型（用 figma-implement-design skill），' +
      '再用量測程式把它修到沒有硬失敗。',
    cwd: repoDir,
    inputs,
    outputs,
    outputFormat:
      '`prototype/index.html`（索引頁）、每個 frame 一頁 `prototype/<frameKey>.html`、' +
      '`prototype/css/tokens.css` 與其他樣式、`prototype/assets/` 裡的圖片與 icon。',
  });

  return {
    audience: 'host',
    type: 'work_order',
    role: 'figma_prototype',
    prompt: body,
    cwd: repoDir,
    inputs,
    outputs,
    resultSchema: 'none',
  };
}

/**
 * The work order that repairs the prototype.
 *
 * @param docsDir - The requirement documents of the run.
 * @param repoDir - The cloned repository (the working directory of the order).
 * @param note - What the measurement found.
 */
export function figmaPolishWorkOrder(
  docsDir: string,
  repoDir: string,
  note: string
): InterruptPayload {
  const prototypeDir = path.join(docsDir, FIGMA_PROTOTYPE_DIR);
  const outputs = [prototypeDir];
  const inputs = [
    path.join(docsDir, FIGMA_DIFF_DIR, 'report.md'),
    ...FIGMA_P0_FILES.map((relative) => path.join(docsDir, relative)),
  ];

  const body = renderWorkOrder('figma-polish', {
    goal: '把量測失敗的 HTML 原型修到量得進去。',
    cwd: repoDir,
    inputs,
    outputs,
    outputFormat: '修好的 `prototype/*.html` 與（需要的話）`prototype/css/`、`prototype/assets/`。',
  });

  return {
    audience: 'host',
    type: 'work_order',
    role: 'figma_polish',
    prompt: `${body}\n\n## 上一輪量測的結果\n\n${note}\n`,
    cwd: repoDir,
    inputs,
    outputs,
    resultSchema: 'none',
  };
}

/**
 * The TBC a failed Figma fetch leaves behind.
 *
 * It is not blocking: a requirement without a UI must not be blocked by it.
 *
 * @param stage - The stage that asked for the files (`prd`, `spec`).
 * @param figmaUrl - The Figma file the run works on.
 * @param result - What the worker reported (may be `undefined`).
 * @param missing - The files that are not on disk (empty when unknown).
 */
export function figmaTbcItem(
  stage: string,
  figmaUrl: string,
  result: unknown,
  missing: string[] = []
): TBCItem {
  const because =
    missing.length > 0
      ? `the P0 files are not all there (missing: ${missing.join(', ')})`
      : summaryOf(result);
  return {
    id: `TBC-FIGMA-${stage}`,
    description: `the Figma P0 files could not be fetched (${figmaUrl}): ${because}`,
    blocking: false,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/** What the worker said about the failure. */
function summaryOf(result: unknown): string {
  const summary =
    typeof result === 'object' && result !== null
      ? String((result as Record<string, unknown>).summary ?? '')
      : '';
  return summary.trim() === '' ? 'the Figma fetch did not finish' : summary.trim();
}

/** How the Figma stage measures the prototype. */
export interface FigmaOptions {
  /**
   * The measurement itself.
   *
   * The tests inject a fake, so that a unit test never starts a browser.
   */
  measure?: (opts: { docsDir: string; repoDir: string }) => Promise<FidelityReport>;
}

/** What the flow needs to know. */
export interface FigmaFlowOptions {
  /** The stage that owns the ledger of this flow (`prd`, `spec`). */
  stage: string;
  /** The requirement documents of the run. */
  docsDir: string;
  /** The cloned repository. */
  repoDir: string;
  /** The Figma file the run works on. */
  figmaUrl: string;
  /** The generation of the stage. */
  gen: number;
  /** How the measurement runs. */
  options?: FigmaOptions;
  /**
   * May the flow fetch the design?
   *
   * `false` means the caller has already fetched it (or has decided not to)
   * and only wants the prototype.
   */
  fetch?: boolean;
}

/** The step that records the answered fetch work order. */
export function figmaFetchStep(gen: number): string {
  return `figma-fetch-done-${gen}`;
}

/** The step that records the answered prototype work order. */
export function figmaPrototypeStep(gen: number): string {
  return `figma-prototype-done-${gen}`;
}

/** The step that records the answered repair work order of a round. */
export function figmaPolishStep(gen: number, round: number): string {
  return `figma-polish-done-${gen}-${round}`;
}

/** The step that records the measurement of a round. */
export function figmaMeasuredStep(gen: number, round: number): string {
  return `figma-measured-${gen}-${round}`;
}

/**
 * The step that records that the design could not be fetched.
 *
 * Without the P0 files there is nothing to build a prototype from, so the
 * flow ends here: the TBC says what is missing.
 */
export function figmaUnusableStep(gen: number): string {
  return `figma-unusable-${gen}`;
}

/** The step that holds the summary of the last measurement. */
export function figmaDiffStep(): string {
  return 'figma-diff-summary';
}

/** The step that holds the question a worker raised. */
export function figmaQuestionStep(gen: number): string {
  return `figma-question-${gen}`;
}

/**
 * Run the Figma stage as far as it can go.
 *
 * The function issues **at most one work order per execution**: the graph
 * parks on every interrupt, and a second `interrupt()` in the same
 * execution would take the next queued answer instead of parking again.
 *
 * @param state - The graph state.
 * @param opts - What the flow needs to know.
 * @returns The outcome of this execution, or `undefined` when the flow is
 *   done and the stage may go on.
 */
export async function figmaFlowStep(
  state: GraphState,
  opts: FigmaFlowOptions
): Promise<NodeOutcome | undefined> {
  const { stage, docsDir, repoDir, figmaUrl, gen } = opts;
  const measure = opts.options?.measure ?? measureFidelity;

  // ---- Step 1: fetch the design ---------------------------------------
  if (opts.fetch !== false && !hasStageStep(state, stage, figmaFetchStep(gen))) {
    const result = interrupt(figmaWorkOrder(docsDir, repoDir, figmaUrl));
    const update = recordStageStep(stage, figmaFetchStep(gen), '');

    // **The file system decides, not the worker.** A worker that answers
    // `status: 'ok'` without writing the files has not done the work, and
    // the stage has to say so.
    const missing = checkFigmaP0(docsDir).missing;
    if (isUnfinishedResult(result) || missing.length > 0) {
      // A Figma file that cannot be read is not fatal: a requirement
      // without a UI must not be blocked by it. And without the P0 files
      // there is nothing to build a prototype from - the flow ends here.
      update.tbcItems = [figmaTbcItem(stage, figmaUrl, result, missing)];
      update.stageSteps = {
        ...(update.stageSteps ?? {}),
        ...(recordStageStep(stage, figmaUnusableStep(gen), '').stageSteps ?? {}),
      };
    }

    // **The question comes first, even when the fetch failed.** A worker
    // that is stuck on a decision it may not make has to reach the user -
    // the missing files are a second problem, not a reason to drop it.
    return { kind: 'advance', update: withQuestion(update, result, stage, gen), goto: stage };
  }

  // ---- Step 2: build the prototype ------------------------------------
  if (hasStageStep(state, stage, figmaUnusableStep(gen))) {
    // The design could not be fetched: there is nothing to prototype.
    return undefined;
  }
  if (!hasStageStep(state, stage, figmaPrototypeStep(gen))) {
    if (prototypeIsReady(docsDir)) {
      // The prototype is already there (an earlier run, or the other
      // stage): there is nothing to ask for.
      return {
        kind: 'advance',
        update: recordStageStep(stage, figmaPrototypeStep(gen), ''),
        goto: stage,
      };
    }
    const result = interrupt(figmaPrototypeWorkOrder(docsDir, repoDir));
    const update = recordStageStep(stage, figmaPrototypeStep(gen), '');
    return { kind: 'advance', update: withQuestion(update, result, stage, gen), goto: stage };
  }

  // ---- Step 3: measure, and repair what could not be measured ----------
  const round = polishRounds(state, stage, gen);
  const measuredStep = figmaMeasuredStep(gen, round);
  if (!hasStageStep(state, stage, measuredStep)) {
    const report = await measure({ docsDir, repoDir });
    const summary = summarize(report);
    const update = recordStageStep(stage, measuredStep, summary);
    update.stageSteps = {
      ...(update.stageSteps ?? {}),
      ...(recordStageStep(stage, figmaDiffStep(), summary).stageSteps ?? {}),
    };

    // **An environment problem is not the prototype's fault.** The machine
    // has no browser (or no Playwright): sending the worker to fix the
    // HTML would waste two round trips on a page that is already fine.
    const environment = report.frames.find((frame) => frame.errorKind === 'environment');
    if (environment !== undefined) {
      update.tbcItems = [environmentTbcItem(stage, figmaUrl, environment)];
      return { kind: 'advance', update, goto: stage };
    }

    if (report.hardFailures > 0 && round < MAX_POLISH_ROUNDS) {
      const result = interrupt(figmaPolishWorkOrder(docsDir, repoDir, summary));
      const merged = recordStageStep(stage, figmaPolishStep(gen, round), '');
      merged.stageSteps = { ...(update.stageSteps ?? {}), ...(merged.stageSteps ?? {}) };
      return { kind: 'advance', update: merged, goto: stage };
    }

    if (report.hardFailures > 0) {
      // The repairs are used up: the user has to decide what to do with a
      // prototype that cannot be compared with the design.
      update.tbcItems = [prototypeTbcItem(stage, figmaUrl, report)];
    } else {
      // The frames were measured, but some of them differ a lot from the
      // design. That does not stop the run - but the user has to see it.
      const drifting = report.frames.filter((frame) => frame.ratio > PIXEL_RATIO_THRESHOLD);
      if (drifting.length > 0) {
        update.tbcItems = [driftTbcItem(stage, figmaUrl, drifting)];
      }
    }

    return { kind: 'advance', update, goto: stage };
  }

  return undefined;
}

/** How many repair rounds are done. */
function polishRounds(state: GraphState, stage: string, gen: number): number {
  let rounds = 0;
  for (let i = 0; i < MAX_POLISH_ROUNDS; i += 1) {
    if (hasStageStep(state, stage, figmaPolishStep(gen, i))) rounds = i + 1;
  }
  return rounds;
}

/** Is the prototype there and does it cover every screenshot? */
function prototypeIsReady(docsDir: string): boolean {
  const prototypeDir = path.join(docsDir, FIGMA_PROTOTYPE_DIR);
  return fs.existsSync(path.join(prototypeDir, 'index.html')) && checkPrototype(docsDir).ok;
}

/**
 * The summary of a measurement, as the worker and the user see it.
 *
 * **Every frame is in it**, measured ones with their ratio: the user sees
 * the numbers at the `confirm_prd` gate, not only in the report file.
 */
function summarize(report: FidelityReport): string {
  const frames = report.frames
    .map(
      (frame) =>
        `- ${frame.key}: ${frame.status} ${(frame.ratio * 100).toFixed(2)}%` +
        `${frame.error ? ` —— ${frame.error}` : ''}`
    )
    .join('\n');
  return [
    `hard failures: ${report.hardFailures}`,
    report.frames.length === 0 ? 'no frame: nothing to compare' : frames,
  ].join('\n');
}

/**
 * The TBC an environment problem leaves behind.
 *
 * **It is blocking**: the machine cannot render, and no amount of rewriting
 * the prototype will change that. A human has to install the browser.
 */
function environmentTbcItem(stage: string, figmaUrl: string, frame: FrameDiff): TBCItem {
  return {
    id: `TBC-FIGMA-ENVIRONMENT-${stage}`,
    description:
      `the HTML prototype could not be measured because of the environment ` +
      `(${figmaUrl}): ${frame.error ?? 'the browser is not available'}`,
    blocking: true,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The TBC a prototype that differs a lot from the design leaves behind.
 *
 * It is **not** blocking: the pixel ratio is a hint (a different font alone
 * can push a frame over the line), and the run goes on.
 */
function driftTbcItem(stage: string, figmaUrl: string, frames: FrameDiff[]): TBCItem {
  const detail = frames
    .map((frame) => `${frame.key} ${(frame.ratio * 100).toFixed(2)}%`)
    .join(', ');
  return {
    id: `TBC-FIGMA-DIFF-${stage}`,
    description:
      `the HTML prototype differs from the Figma screenshots (${figmaUrl}): ${detail}. ` +
      `這是參考值，不是判定：字體不同也會讓比例偏高。`,
    blocking: false,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/** The TBC a prototype that cannot be measured leaves behind. */
function prototypeTbcItem(stage: string, figmaUrl: string, report: FidelityReport): TBCItem {
  const failed = report.frames
    .filter((frame) => frame.status !== 'ok')
    .map((frame) => `${frame.key} (${frame.status})`)
    .join(', ');
  return {
    id: `TBC-FIGMA-PROTOYPE-${stage}`,
    description:
      `the HTML prototype could not be measured against the Figma screenshots ` +
      `(${figmaUrl}): ${failed}`,
    blocking: true,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/** Record the question a worker raised, if it raised one. */
function withQuestion(
  update: Partial<GraphState>,
  result: unknown,
  stage: string,
  gen: number
): Partial<GraphState> {
  // A worker that needs a decision it may not make raises a question:
  // the graph asks the user instead of the worker asking the user.
  const question = recordWorkerQuestion(result, { stage, step: figmaQuestionStep(gen) });
  if (question !== undefined) {
    update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
  }
  return update;
}
