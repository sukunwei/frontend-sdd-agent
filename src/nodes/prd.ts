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
import {
  artifactsOf,
  collectedSummary,
  readPrdInputs,
  writeCollectedInputs,
} from './prd-inputs.js';
import type { CollectedInputs } from './prd-inputs.js';

/**
 * The PRD stage: the requirements come from the user, not from the model.
 *
 * The stage asks three times, one question per execution:
 *
 * 1. `collect_prd` (the user): **everything the requirement needs, in one
 *    go** - the PRD (a file path or a text), the design (a Figma link or a
 *    description in words) and any other documents the user wants the spec
 *    writer to read. **The PRD is never written before the user provided
 *    it**: a model that invents the requirements and then asks for a
 *    correction produces a document the user has to fight with, not one they
 *    wrote.
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

/**
 * The step that holds the design decision of the current PRD.
 *
 * `url` —— the user gave a Figma link; the P0 files are fetched.
 * `text` —— the user described the design in words.
 * `none` —— there is no design.
 *
 * **The spec stage reads it so that it does not ask about the design a
 * second time.** A run that has no decision recorded is an older run, and
 * it keeps the old behaviour.
 */
export const STEP_DESIGN = 'design';

/**
 * The stage that recorded the design decision.
 *
 * The spec stage reads it from here: the decision was made once, at the
 * `collect_prd` gate, and the spec stage must not ask about the design a
 * second time.
 */
export const DESIGN_STAGE = STAGE;

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
    const answer = interrupt(collectPrdPayload(collectDiagnostic(state, gen)));

    // The answer has to have a PRD. A shape the gate never asked for is a
    // mistake of the host, and it is loud about it: the gate shows the shape
    // it wants, so an answer that does not fit it has to be said out loud
    // rather than asked again silently.
    const inputs = readPrdInputs(answer);

    let collected: CollectedInputs;
    try {
      collected = writeCollectedInputs(docsDirOf(state), inputs);
    } catch (err) {
      // **A file the user pointed at cannot be read.** That is the user's
      // mistake, not the host's - so the gate asks again, with the reason,
      // instead of the run dying on it.
      return {
        kind: 'advance',
        update: recordStageStep(STAGE, collectFailedStep(gen), errorMessage(err)),
        goto: STAGE,
      };
    }

    const update = recordStageStep(STAGE, collectedStep(gen), '');
    update.stageSteps = {
      ...(update.stageSteps ?? {}),
      // The design decision: the spec stage must not ask about the design
      // again when the user already answered it here.
      ...(recordStageStep(STAGE, STEP_DESIGN, collected.design).stageSteps ?? {}),
      ...(recordStageStep(STAGE, collectSummaryStep(gen), JSON.stringify(collectedSummary(collected)))
        .stageSteps ?? {}),
      ...(collected.figmaUrl !== undefined
        ? (recordStageStep(STAGE, STEP_FIGMA_URL, collected.figmaUrl).stageSteps ?? {})
        : {}),
    };
    update.artifacts = { ...(update.artifacts ?? {}), ...artifactsOf(collected.files) };
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
  // The payload says **what the graph actually collected** - the PRD came
  // from this file, the design was described in these words, these other
  // documents were read. The user approves without having to guess.
  const answer = interrupt({
    audience: 'user',
    type: 'confirm_prd',
    collected: collectedSummaryOf(state),
  });
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
 * The payload carries the **questions** (the host asks them) and the
 * **shape of the answer** (the host builds it). Three things are asked for
 * in one go, so the requirement is not pieced together across three
 * interruptions:
 *
 * 1. the PRD - a file path or the text itself,
 * 2. the design - a Figma link or a description in words,
 * 3. the other documents - optional.
 *
 * @param diagnostic - Why the last answer could not be used, if it could
 *   not. The gate asks again with the reason, so the user knows which of
 *   their answers went wrong.
 */
function collectPrdPayload(diagnostic?: string): InterruptPayload {
  return {
    audience: 'user',
    type: 'collect_prd',
    question: [
      '1. **PRD** —— 這次要做什麼？給一個文件路徑（圖自己去讀），或直接用文字描述。',
      '2. **Figma** —— 設計檔連結，或用文字描述設計；沒有設計就說沒有。',
      '3. **其他文件** —— 要讓規格階段一起讀的文件（選填，給路徑或文字）。',
    ].join('\n'),
    answer: {
      prd: '<the requirements, as markdown> | { "path": "/absolute/path/to/PRD.md" }',
      figma:
        '<the URL of the Figma file> | { "url": "<the URL>" } | { "text": "<the design, in words>" } | null',
      docs: ['{ "path": "/absolute/path/to/other.md" } | { "name": "other.md", "text": "..." }'],
    },
    ...(diagnostic !== undefined ? { note: diagnostic } : {}),
  };
}

/**
 * The diagnostic of the last answer that could not be used.
 *
 * @param state - The graph state.
 * @param gen - The generation of the stage.
 * @returns The reason, or `undefined` when there was none.
 */
function collectDiagnostic(state: GraphState, gen: number): string | undefined {
  const raw = readStageStep(state, STAGE, collectFailedStep(gen));
  return raw === undefined || raw === '' ? undefined : raw;
}

/** The step that records a failed collection of a generation. */
function collectFailedStep(gen: number): string {
  return `collect-failed-${gen}`;
}

/** The step that holds what was collected, for the confirmation gate. */
function collectSummaryStep(gen: number): string {
  return `collect-summary-${gen}`;
}

/**
 * What the graph collected, as the confirmation gate shows it.
 *
 * @param state - The graph state.
 * @returns The summary, or `undefined` when there is none.
 */
function collectedSummaryOf(state: GraphState): Record<string, unknown> | undefined {
  const raw = readStageStep(state, STAGE, collectSummaryStep(stageGeneration(state, STAGE)));
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The message of an error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
