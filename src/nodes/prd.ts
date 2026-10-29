import * as fs from 'fs';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import { answerText, isApproved, isUnfinishedResult } from '../cli/protocol.js';
import { STAGE_NODE_NAMES } from '../graph/node-names.js';
import {
  hasStageStep,
  readStageStep,
  recordStageStep,
  stageGeneration,
  withNextGeneration,
} from '../graph/state.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import { renderWorkOrder } from '../prompts/loader.js';
import { getDocsDir } from '../runtime/paths.js';
import type { TBCItem } from '../state/types.js';
import { answerSummary, askWorkerQuestion, recordWorkerQuestion } from './stage-gates.js';

/**
 * The PRD stage: the requirements come from the user, not from the model.
 *
 * The stage asks three times, one question per execution:
 *
 * 1. `collect_prd` (the user): the PRD and - optionally - the URL of a
 *    Figma file. **The PRD is never written before the user provided it**: a
 *    model that invents the requirements and then asks for a correction
 *    produces a document the user has to fight with, not one they wrote.
 * 2. `figma_fetch` (the host): only when the user gave a Figma URL. The
 *    graph does not talk to Figma - the **current Claude Code session**
 *    does, with the MCP tools it already has. A worker that needs a human
 *    decision raises a question of its own, and the graph turns it into a
 *    `figma_needs_human` gate.
 * 3. `confirm_prd` (the user): the last word before the spec stage. A
 *    rejected PRD is collected again.
 *
 * **One interrupt per execution.** A second `interrupt()` in the same
 * execution would take the *next* queued answer instead of parking again,
 * so the questions are spread over several executions and the stage keeps
 * its progress in the ledger (see `stageStepKey`).
 */

/** The stage this node owns. */
const STAGE = 'prd';

/** The step that holds the Figma URL of the current PRD. */
const STEP_FIGMA_URL = 'figma-url';

/** The step that records that the Figma work order was answered. */
const STEP_FIGMA_DONE = 'figma-done';

/** The step that holds the question a worker raised. */
const STEP_FIGMA_QUESTION = 'figma-question';

/** The step that records that the user answered the question. */
const STEP_FIGMA_ANSWERED = 'figma-answered';

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

/** The directory the screenshots have to go to. */
export const FIGMA_SCREENSHOT_DIR = 'figma/screenshots';

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
 * The Figma work order.
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
    `\`outputs\` is the screenshot directory: put at least one png into`,
    `${screenshotDir} (the name of the file is yours).`,
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
      '以及至少一張 png 截圖。',
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
 * The PRD stage.
 *
 * @param state - The graph state (`requirementName`, `repoPath`).
 */
export async function prdNode(state: GraphState): Promise<NodeOutcome> {
  const repoDir = state.repoPath;
  const gen = stageGeneration(state, STAGE);

  // ---- Step 1: the requirements come from the user ----------------------
  if (!hasStageStep(state, STAGE, collectedStep(gen))) {
    const answer = interrupt(collectPrdPayload());
    const prdMarkdown = readPrdMarkdown(answer);
    writePrd(docsDirOf(state), prdMarkdown);
    const update = recordStageStep(STAGE, collectedStep(gen), '');
    update.stageSteps = {
      ...(update.stageSteps ?? {}),
      ...(recordStageStep(STAGE, STEP_FIGMA_URL, readFigmaUrl(answer)).stageSteps ?? {}),
    };
    return { kind: 'advance', update, goto: STAGE };
  }

  // ---- Step 2: the Figma P0 files ---------------------------------------
  const figmaUrl = readStageStep(state, STAGE, STEP_FIGMA_URL) ?? '';
  if (figmaUrl !== '' && !hasStageStep(state, STAGE, figmaDoneStep(gen))) {
    const docsDir = docsDirOf(state);
    const result = interrupt(figmaWorkOrder(docsDir, repoDir, figmaUrl));
    const update = recordStageStep(STAGE, figmaDoneStep(gen), '');

    // **The file system decides, not the worker.** A worker that answers
    // `status: 'ok'` without writing the files has not done the work, and
    // the stage has to say so.
    const missing = checkFigmaP0(docsDir).missing;
    if (isUnfinishedResult(result) || missing.length > 0) {
      // A Figma file that cannot be read is not fatal: a requirement
      // without a UI must not be blocked by it.
      update.tbcItems = [figmaTbcItem(STAGE, figmaUrl, result, missing)];
    }

    // A worker that needs a decision it may not make raises a question:
    // the graph asks the user instead of the worker asking the user.
    const question = recordWorkerQuestion(result, {
      stage: STAGE,
      step: figmaQuestionStep(gen),
    });
    if (question !== undefined) {
      update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
    }

    return { kind: 'advance', update, goto: STAGE };
  }

  // ---- Step 3: the question the worker raised ----------------------------
  const gate = askWorkerQuestion(state, {
    stage: STAGE,
    step: figmaQuestionStep(gen),
    answeredStep: figmaAnsweredStep(gen),
    type: 'figma_needs_human',
    goto: STAGE,
    tbcId: 'TBC-FIGMA-ANSWER',
  });
  if (gate !== undefined) return gate;

  // ---- Step 4: the confirmation -----------------------------------------
  const answer = interrupt({ audience: 'user', type: 'confirm_prd' });
  if (!isApproved(answer)) {
    // The user does not want this PRD: the next generation collects it
    // again.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: STAGE };
  }

  return {
    kind: 'advance',
    update: {
      currentStage: 'spec',
      approvals: { prd: new Date().toISOString() },
    },
    goto: STAGE_NODE_NAMES.spec,
  };
}

/**
 * The payload of the gate that asks for the requirements.
 *
 * The payload names the shape of the answer: the host has to know which
 * fields it has to send, and the node has to be able to say so when the
 * answer does not have that shape.
 */
function collectPrdPayload(): InterruptPayload {
  return {
    audience: 'user',
    type: 'collect_prd',
    answer: {
      prdMarkdown: '<the requirements, as markdown>',
      figmaUrl: '<the URL of the Figma file (optional)>',
    },
  };
}

/**
 * The PRD of the answer.
 *
 * @throws Error when the answer has a shape the node does not understand.
 *   Asking the same question again and again without saying why would be
 *   worse than failing: the user would never learn what is wrong.
 */
function readPrdMarkdown(answer: unknown): string {
  if (typeof answer === 'string' && answer.trim() !== '') {
    return answer.trim();
  }
  if (typeof answer === 'object' && answer !== null) {
    const markdown = (answer as { prdMarkdown?: unknown }).prdMarkdown;
    if (typeof markdown === 'string' && markdown.trim() !== '') {
      return markdown.trim();
    }
  }
  throw new Error(
    'the collect_prd gate expects an answer of the shape ' +
      '{"prdMarkdown": "<the requirements, as markdown>", "figmaUrl": "<the Figma file (optional)>"} ' +
      '(the markdown itself is accepted as well), ' +
      `but got ${JSON.stringify(answer)}`
  );
}

/** The Figma URL of the answer (empty when there is none). */
function readFigmaUrl(answer: unknown): string {
  if (typeof answer !== 'object' || answer === null) return '';
  return answerText(answer, 'figmaUrl');
}

/** Write the PRD the user gave. */
function writePrd(docsDir: string, markdown: string): void {
  fs.mkdirSync(docsDir, { recursive: true });
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  fs.writeFileSync(path.join(docsDir, 'prd.md'), text, 'utf-8');
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
  const summary = answerText(result, 'summary');
  return summary === '' ? 'the Figma fetch did not finish' : summary;
}

/** Where the requirement documents of the run live. */
function docsDirOf(state: GraphState): string {
  return getDocsDir(state.requirementName, state.repoPath);
}

/** The step that records the collection of a generation. */
function collectedStep(gen: number): string {
  return `collected-${gen}`;
}

/** The step that records the answered Figma work order of a generation. */
function figmaDoneStep(gen: number): string {
  return `${STEP_FIGMA_DONE}-${gen}`;
}

/** The step that holds the question a worker raised in a generation. */
function figmaQuestionStep(gen: number): string {
  return `${STEP_FIGMA_QUESTION}-${gen}`;
}

/** The step that records the answer of the user in a generation. */
function figmaAnsweredStep(gen: number): string {
  return `${STEP_FIGMA_ANSWERED}-${gen}`;
}
