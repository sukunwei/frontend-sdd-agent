import * as fs from 'fs';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import { answerText, isApproved, isUnfinishedResult } from '../cli/protocol.js';
import { STAGE_NODE_NAMES } from '../graph/node-names.js';
import {
  hasStageStep,
  readStageReading,
  readStageStep,
  recordStageReading,
  recordStageStep,
  stageGeneration,
  withNextGeneration,
} from '../graph/state.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import { actionOf } from '../nodes/bootstrap.js';
import {
  checkFigmaP0,
  DESIGN_STAGE,
  FIGMA_P0_FILES,
  figmaTbcItem,
  figmaWorkOrder,
  STEP_DESIGN,
} from '../nodes/prd.js';
import { parseAcIds, parseQuestions, parseTbcItems } from '../parsers/ids.js';
import { DESIGN_FILE, REFS_DIR } from '../nodes/prd-inputs.js';
import { renderWorkOrder } from '../prompts/loader.js';
import { getDocsDir, readDoc } from '../runtime/paths.js';
import type { SpecQuestion, TBCItem } from '../state/types.js';
import {
  answerSummary,
  askWorkerQuestion,
  recordWorkerQuestion,
  workerFailedTbc,
} from './stage-gates.js';

/**
 * The spec stage: a host work order writes the spec, the graph keeps the gate.
 *
 * The worker writes `discovery.md` (what it explored and what it had to
 * clarify) and `spec.md` (the specification itself). The graph does not
 * judge the prose - it runs the deterministic parsers over the result and
 * asks the user when the documents are not complete:
 *
 * 1. **Figma.** If the P0 files of the design are missing, the user decides:
 *    fetch them, note them as a TBC, or skip them (a requirement without a
 *    UI does not need a design).
 * 2. **Acceptance criteria.** A spec without a single `AC-xxx` is not a
 *    spec: the work order is issued once more, and if the criteria still are
 *    missing the user is asked for them - the answer becomes the criteria.
 * 3. **Clarification questions.** The questions the worker could not answer
 *    are asked as well - at most three rounds; a question that survives the
 *    third round becomes a TBC.
 * 4. **Blocking TBCs.** An unresolved blocking TBC keeps the run in this
 *    stage: the spec stage does not advance to `e2ePlan` over it.
 * 5. **The confirmation.** The user has the last word - but only over a spec
 *    that has acceptance criteria.
 *
 * **Why the stage reads the documents in its own execution.** LangGraph
 * re-executes the whole node when the run is resumed, and the worker writes
 * `spec.md` *between* the execution that parks and the one that resumes it.
 * A node that decides what to ask by reading the files again would take a
 * different branch on the second run - and the answer of the user would be
 * handed to the wrong interrupt. So the stage reads the documents once, puts
 * the reading into the ledger, and decides from there (the same pattern the
 * verification stage uses for its gates).
 */

/** The stage this node owns. */
const STAGE = 'spec';

/** How many clarification rounds are allowed. */
export const MAX_QUESTION_ROUNDS = 3;

/** The step that records that the Figma P0 files are missing. */
const STEP_FIGMA_MISSING = 'figma-missing';

/** The step that records that the Figma P0 files are there. */
const STEP_FIGMA_PRESENT = 'figma-present';

/** The step that records the answered Figma work order. */
const STEP_FIGMA_DONE = 'figma-done';

/** The step that records that there was no Figma file to fetch. */
const STEP_FIGMA_NO_URL = 'figma-no-url';

/** The step that holds the question a worker raised. */
const STEP_FIGMA_QUESTION = 'figma-question';

/** The step that records that the user answered the question. */
const STEP_FIGMA_ANSWERED = 'figma-answered';

/** The step that holds the question the spec writer raised. */
const STEP_SPEC_QUESTION = 'spec-question';

/** The step that records that the user answered the spec writer. */
const STEP_SPEC_ANSWERED = 'spec-answered';

/** The steps that record the spec work orders. */
const STEP_ORDER_1 = 'order-1';
const STEP_ORDER_2 = 'order-2';

/** The decisions the user may make at the Figma gate. */
const FIGMA_ACTIONS = ['fetch', 'tbc', 'skip'] as const;

/** A decision of the Figma gate. */
type FigmaAction = (typeof FIGMA_ACTIONS)[number];

/**
 * What the spec stage found in the documents.
 *
 * `acIds` and `openQuestions` are read from `spec.md`, and so are the
 * blocking TBCs: **the document is the truth.** The state only remembers
 * that the user has already resolved a TBC - a worker that escalates a TBC
 * to `blocking` in a later draft is not masked by an old copy of it, and a
 * TBC the worker removed does not keep blocking the stage.
 */
export interface SpecExit {
  /** Everything the stage needs is there. */
  ok: boolean;
  /** The acceptance criteria of the spec. */
  acIds: string[];
  /** The blocking TBCs that are not resolved yet. */
  blockingTbc: TBCItem[];
  /** The clarification questions nobody answered yet. */
  openQuestions: SpecQuestion[];
  /** The spec has no acceptance criteria at all. */
  missingAc: boolean;
}

/**
 * What the reading of the documents says.
 *
 * The reading is what the node decides from - the exit plus the TBCs that
 * go back into the state, or the reason why the documents could not be read.
 */
interface SpecReading {
  /** The exit, when the documents could be read. */
  exit?: SpecExit;
  /** The TBCs of the document, reconciled with the state. */
  tbcs?: TBCItem[];
  /** Why the documents could not be read. */
  error?: string;
}

/** The spec node and its exit. */
export interface SpecNode {
  (state: GraphState): Promise<NodeOutcome>;
  /** What the documents of the run say. */
  exit(state: GraphState, docsDir: string): SpecExit;
}

/**
 * Read the documents of the run and say whether the stage may go on.
 *
 * The function is pure: it reads two things (the spec and the state) and
 * returns what it found. The node decides what to do about it.
 *
 * @param state - The graph state (the TBC ledger).
 * @param docsDir - The requirement documents of the run.
 * @throws Error when `spec.md` exists but cannot be read - a broken document
 *   is not an empty document.
 */
export function specExit(state: GraphState, docsDir: string): SpecExit {
  const specMd = readSpec(docsDir);
  const acIds = parseAcIds(specMd);
  const openQuestions = parseQuestions(specMd).filter((question) => question.status === 'pending');
  const blockingTbc = reconcileTbcItems(parseTbcItems(specMd), state.tbcItems ?? []).filter(
    (item) => item.blocking && !item.resolved
  );
  const missingAc = acIds.length === 0;

  return {
    ok: !missingAc && blockingTbc.length === 0 && openQuestions.length === 0,
    acIds,
    blockingTbc,
    openQuestions,
    missingAc,
  };
}

/**
 * The spec node, with its exit.
 *
 * The exit is a pure function of the documents and the state, so it can be
 * asked what a spec looks like without running the graph.
 */
export const specNode: SpecNode = Object.assign(specNodeImpl, { exit: specExit });

/** The implementation of the node. */
async function specNodeImpl(state: GraphState): Promise<NodeOutcome> {
  const repoDir = state.repoPath;
  const gen = stageGeneration(state, STAGE);

  // ---- Step 1: the Figma gate -------------------------------------------
  // **The finding is persisted.** The P0 files may appear between the
  // execution that parks and the one that resumes it, and a node that
  // recomputes the finding would take a different branch - the decision of
  // the user would be dropped.
  const p0 = figmaFinding(state);
  if (p0 === undefined) {
    const found = checkFigmaP0(docsDirOf(state));
    const update = recordStageStep(
      STAGE,
      found.ok ? STEP_FIGMA_PRESENT : STEP_FIGMA_MISSING,
      JSON.stringify(found.missing)
    );
    return { kind: 'advance', update, goto: STAGE };
  }

  if (p0 === STEP_FIGMA_MISSING && worthAskingAboutTheDesign(state)) {
    const decision = figmaDecision(state);
    if (decision === undefined) {
      const answer = interrupt({
        audience: 'user',
        type: 'figma_missing',
        options: [...FIGMA_ACTIONS],
        missing: missingFiles(state),
      });
      const action = normalizeFigmaAction(actionOf(answer));
      const update = recordStageStep(STAGE, `figma-${action}`);
      if (action === 'tbc') {
        update.tbcItems = [figmaTbcItem(STAGE, figmaUrlOf(state), undefined)];
      }
      return { kind: 'advance', update, goto: STAGE };
    }

    if (
      decision === 'fetch' &&
      !hasStageStep(state, STAGE, STEP_FIGMA_DONE) &&
      !hasStageStep(state, STAGE, STEP_FIGMA_NO_URL)
    ) {
      const url = figmaUrlOf(state);
      if (url === '') {
        // The user asked for a fetch, but nobody gave a Figma file: there is
        // nothing to fetch. The stage goes on without the design context.
        const update = recordStageStep(STAGE, STEP_FIGMA_NO_URL);
        update.tbcItems = [noFigmaUrlTbc()];
        return { kind: 'advance', update, goto: STAGE };
      }
      const result = interrupt(figmaWorkOrder(docsDirOf(state), repoDir, url));
      const update = recordStageStep(STAGE, STEP_FIGMA_DONE);
      if (isUnfinishedResult(result)) {
        update.tbcItems = [
          figmaTbcItem(STAGE, url, result, checkFigmaP0(docsDirOf(state)).missing),
        ];
      }
      const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_FIGMA_QUESTION });
      if (question !== undefined) {
        update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
      }
      return { kind: 'advance', update, goto: STAGE };
    }
  }

  // ---- Step 2: the question a worker raised ------------------------------
  const gate = askWorkerQuestion(state, {
    stage: STAGE,
    step: STEP_FIGMA_QUESTION,
    answeredStep: STEP_FIGMA_ANSWERED,
    type: 'figma_needs_human',
    goto: STAGE,
    tbcId: 'TBC-FIGMA-ANSWER',
  });
  if (gate !== undefined) return gate;

  // ---- Step 3: the spec work order --------------------------------------
  if (!hasStageStep(state, STAGE, STEP_ORDER_1)) {
    const result = interrupt(specWorkOrder(docsDirOf(state), repoDir));
    const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_1));
    if (isUnfinishedResult(result)) {
      update.tbcItems = [orderFailedTbc(result)];
    }
    // A worker that needs a decision it may not make raises a question:
    // the graph asks the user instead of the worker asking the user.
    const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_SPEC_QUESTION });
    if (question !== undefined) {
      update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
    }
    return { kind: 'advance', update, goto: STAGE };
  }

  // ---- Step 3b: the question the spec writer raised ---------------------
  const specGate = askWorkerQuestion(state, {
    stage: STAGE,
    step: STEP_SPEC_QUESTION,
    answeredStep: STEP_SPEC_ANSWERED,
    type: 'worker_needs_human',
    goto: STAGE,
    tbcId: 'TBC-SPEC-ANSWER',
  });
  if (specGate !== undefined) return specGate;

  // ---- Step 4: read the documents ----------------------------------------
  // The reading goes into the ledger: from here on the stage decides from
  // the state, never from the files (the worker rewrites them).
  const reading = readStageReading<SpecReading>(state, STAGE, gen);
  if (reading === undefined) {
    const computed = readDocuments(state, docsDirOf(state));
    const update = recordStageReading(STAGE, gen, computed);
    // The TBCs of the document go to the state as well: the mirror of the
    // state has to show what the spec is waiting for.
    if (computed.tbcs !== undefined) update.tbcItems = computed.tbcs;
    return { kind: 'advance', update, goto: STAGE };
  }

  if (reading.error !== undefined) {
    // The documents cannot be read: the worker gets one more chance, then
    // the user decides.
    if (!hasStageStep(state, STAGE, STEP_ORDER_2)) {
      const result = interrupt(
        specWorkOrder(docsDirOf(state), repoDir, `The documents could not be read: ${reading.error}`)
      );
      const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_2));
      if (isUnfinishedResult(result)) {
        update.tbcItems = [orderFailedTbc(result)];
      }
      const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_SPEC_QUESTION });
      if (question !== undefined) {
        update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
      }
      return { kind: 'advance', update, goto: STAGE };
    }
    const answer = interrupt({
      audience: 'user',
      type: 'spec_failed',
      reason: 'unreadable_spec',
      message: reading.error,
      options: [...FAILURE_ACTIONS],
    });
    if (actionOf(answer) === 'abort') {
      // The user gives up: the run ends with a blocker on record.
      return abortRun(state, `the spec could not be read: ${reading.error}`);
    }
    // The documents are read again: the user may have fixed them.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: STAGE };
  }

  const exit = reading.exit as SpecExit;

  // ---- Step 5: one re-issue, then the user -------------------------------
  if (exit.missingAc && !hasStageStep(state, STAGE, STEP_ORDER_2)) {
    // One re-issue: the worker gets a second chance before the user is
    // asked - and the order tells it what was wrong.
    const result = interrupt(
      specWorkOrder(
        docsDirOf(state),
        repoDir,
        'The spec has no acceptance criteria (### AC-xxx): write at least one.'
      )
    );
    const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_2));
    if (isUnfinishedResult(result)) {
      update.tbcItems = [orderFailedTbc(result)];
    }
    const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_SPEC_QUESTION });
    if (question !== undefined) {
      update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
    }
    return { kind: 'advance', update, goto: STAGE };
  }

  // ---- Step 6: the clarification questions -------------------------------
  const round = questionRound(state);
  if (exit.openQuestions.length > 0 || exit.missingAc) {
    if (round < MAX_QUESTION_ROUNDS) {
      // The questions of the gate: the open ones, or the synthetic question
      // of the "no acceptance criteria" gate.
      const questions = questionsOf(exit);
      const answer = interrupt(questionsPayload(questions, exit.missingAc));
      const answers = readAnswers(answer, questions);
      // The answers of the questions land on the questions; the answer of
      // the "no acceptance criteria" gate becomes the criteria.
      const { [SYNTHETIC_QUESTION_ID]: _synthetic, ...questionAnswers } = answers;
      let updated = applyAnswers(readSpec(docsDirOf(state)), questionAnswers);
      if (exit.missingAc) {
        updated = applyAcceptanceCriteria(updated, criteriaOf(answers, answer));
      }
      writeSpec(docsDirOf(state), updated);
      const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, `questions-${round + 1}`));
      return { kind: 'advance', update, goto: STAGE };
    }

    if (exit.openQuestions.length > 0) {
      // Three rounds are over: a question nobody answered becomes a TBC.
      const converted = questionsToTbc(readSpec(docsDirOf(state)), exit.openQuestions);
      writeSpec(docsDirOf(state), converted.text);
      const update = withNextGeneration(STAGE, gen, { tbcItems: converted.tbcs });
      return { kind: 'advance', update, goto: STAGE };
    }
  }

  // ---- Step 7: the blocking TBCs -----------------------------------------
  if (exit.blockingTbc.length > 0) {
    const answer = interrupt({
      audience: 'user',
      type: 'tbc_blocking',
      resolutions: exit.blockingTbc.map((item) => ({
        id: item.id,
        description: item.description,
      })),
    });
    const resolutions = readResolutions(answer);
    writeSpec(docsDirOf(state), applyResolutions(readSpec(docsDirOf(state)), resolutions));
    const resolved = exit.blockingTbc.map((item) => {
      const resolution = resolutions[item.id];
      if (resolution === undefined) return item;
      return { ...item, resolved: true, resolution };
    });
    const update = withNextGeneration(STAGE, gen, { tbcItems: resolved });
    return { kind: 'advance', update, goto: STAGE };
  }

  // ---- Step 8: no acceptance criteria, no advance ------------------------
  if (exit.missingAc) {
    // Three rounds of questions did not produce a single criterion: the
    // user has to fix the document (or the worker has to write it).
    const answer = interrupt({
      audience: 'user',
      type: 'spec_failed',
      reason: 'no_acceptance_criteria',
      message: 'the spec has no acceptance criteria (### AC-xxx): the stage cannot be accepted',
      options: [...FAILURE_ACTIONS],
    });
    if (actionOf(answer) === 'abort') {
      // The user gives up: the run ends with a blocker on record.
      return abortRun(state, 'the spec has no acceptance criteria');
    }
    // The documents are read again: the user may have fixed them.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: STAGE };
  }

  // ---- Step 9: the confirmation ------------------------------------------
  const answer = interrupt({ audience: 'user', type: 'confirm_spec' });
  if (!isApproved(answer)) {
    // The documents are read again: the user may have changed them.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: STAGE };
  }

  return {
    kind: 'advance',
    update: {
      currentStage: 'e2ePlan',
      approvals: { spec: new Date().toISOString() },
    },
    goto: STAGE_NODE_NAMES.e2ePlan,
  };
}

/**
 * Read the documents of the run.
 *
 * @throws Error when `spec.md` exists but cannot be read.
 */
function readDocuments(state: GraphState, docsDir: string): SpecReading {
  try {
    const specMd = readSpec(docsDir);
    const tbcs = reconcileTbcItems(
      parseTbcItems(specMd, { createdAt: new Date().toISOString() }),
      state.tbcItems ?? []
    );
    return { exit: specExit({ ...state, tbcItems: tbcs }, docsDir), tbcs };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reconcile the TBCs of the document with the ones on record.
 *
 * **The document decides what a TBC is.** A worker that escalates a TBC to
 * `blocking` in a later draft is not masked by the old copy in the state,
 * and a TBC the worker removed does not keep blocking the stage. The state
 * only remembers what the *user* did: a TBC they resolved stays resolved.
 */
function reconcileTbcItems(documentItems: TBCItem[], stateItems: TBCItem[]): TBCItem[] {
  const known = new Map(stateItems.map((item) => [item.id, item]));
  return documentItems.map((item) => {
    const previous = known.get(item.id);
    if (!previous) return item;
    const merged: TBCItem = { ...item, createdAt: previous.createdAt || item.createdAt };
    if (previous.resolved) {
      merged.resolved = true;
      if (previous.resolution !== undefined) merged.resolution = previous.resolution;
    }
    return merged;
  });
}

/**
 * The spec work order.
 *
 * The worker reads the PRD, the design context (when it is there) and the
 * conventions of the repository, and writes the two documents of the stage.
 *
 * @param docsDir - The requirement documents of the run.
 * @param repoDir - The cloned repository (the working directory of the order).
 * @param note - What the last attempt got wrong (the re-issue).
 */
export function specWorkOrder(
  docsDir: string,
  repoDir: string,
  note?: string
): InterruptPayload {
  const inputs = [path.join(docsDir, 'prd.md')];
  // A design the user described in words is part of the requirement.
  const design = path.join(docsDir, DESIGN_FILE);
  if (fs.existsSync(design)) inputs.push(design);
  for (const relative of FIGMA_P0_FILES) {
    const file = path.join(docsDir, relative);
    if (fs.existsSync(file)) inputs.push(file);
  }
  // The other documents the user gave are reference material for the spec.
  for (const file of referenceFiles(docsDir)) inputs.push(file);
  const claudeMd = path.join(repoDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) inputs.push(claudeMd);

  const outputs = [path.join(docsDir, 'discovery.md'), path.join(docsDir, 'spec.md')];
  const body = renderWorkOrder('spec-writer', {
    goal: '把 PRD 與設計脈絡寫成一份可實作、可驗收的規格。',
    cwd: repoDir,
    inputs,
    outputs,
    outputFormat:
      '兩份 Markdown：`discovery.md`（探索與澄清紀錄）與 `spec.md`（規格本體，' +
      '必須有 `## Acceptance Criteria` 節，每條驗收條件以 `### AC-001: ...` 起頭）。',
  });
  const prompt =
    note === undefined ? body : `${body}\n\n## What the last attempt got wrong\n\n${note}\n`;

  return {
    audience: 'host',
    type: 'work_order',
    role: 'spec_writer',
    prompt,
    cwd: repoDir,
    inputs,
    outputs,
    resultSchema: 'none',
  };
}

/** Where the requirement documents of the run live. */
function docsDirOf(state: GraphState): string {
  return getDocsDir(state.requirementName, state.repoPath);
}

/**
 * The reference documents the user gave at the `collect_prd` gate.
 *
 * @param docsDir - The requirement directory of the run.
 * @returns The files in `refs/`, sorted by name.
 */
function referenceFiles(docsDir: string): string[] {
  const dir = path.join(docsDir, REFS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Is the design worth asking about again?
 *
 * **The user already answered this at the `collect_prd` gate.** The prd
 * stage recorded what they said: a Figma link (`url`), a description in
 * words (`text`) or nothing (`none`).
 *
 * - `url` —— the P0 files are missing, so the fetch did not work. That is
 *   worth asking about: fetch again, turn it into a TBC, or skip.
 * - `text` —— the design is in words. There is nothing to fetch, and asking
 *   again would only make the user answer the same question twice.
 * - `none` —— there is no design. Same thing.
 * - nothing recorded —— an older run, which never had the question. It
 *   keeps the old behaviour and asks.
 *
 * @param state - The graph state.
 */
function worthAskingAboutTheDesign(state: GraphState): boolean {
  const decision = readStageStep(state, DESIGN_STAGE, STEP_DESIGN);
  if (decision === 'text' || decision === 'none') return false;
  return true;
}

/**
 * The Figma finding of the stage: are the P0 files there?
 *
 * `undefined` means the finding is not on record yet.
 */
function figmaFinding(state: GraphState): string | undefined {
  if (hasStageStep(state, STAGE, STEP_FIGMA_MISSING)) return STEP_FIGMA_MISSING;
  if (hasStageStep(state, STAGE, STEP_FIGMA_PRESENT)) return STEP_FIGMA_PRESENT;
  return undefined;
}

/** The files that were missing when the stage looked. */
function missingFiles(state: GraphState): string[] {
  const raw = readStageStep(state, STAGE, STEP_FIGMA_MISSING);
  if (raw === undefined) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/** The decision the user made at the Figma gate. */
function figmaDecision(state: GraphState): FigmaAction | undefined {
  for (const action of FIGMA_ACTIONS) {
    if (hasStageStep(state, STAGE, `figma-${action}`)) return action;
  }
  return undefined;
}

/** An answer the node does not understand is treated as "skip". */
function normalizeFigmaAction(action: string | undefined): FigmaAction {
  return FIGMA_ACTIONS.includes(action as FigmaAction) ? (action as FigmaAction) : 'skip';
}

/**
 * The Figma file of the run.
 *
 * The user gave it at the PRD stage; the spec stage may fetch it when the
 * files are missing. The PRD stage keeps it in its ledger under a fixed
 * step, so that a PRD that was collected again does not lose it.
 */
function figmaUrlOf(state: GraphState): string {
  return readStageStep(state, 'prd', 'figma-url') ?? '';
}

/** How many clarification rounds have been asked so far. */
function questionRound(state: GraphState): number {
  let round = 0;
  while (hasStageStep(state, STAGE, `questions-${round + 1}`)) round += 1;
  return round;
}

/** What the user may answer when a gate of the stage cannot be passed. */
const FAILURE_ACTIONS = ['retry', 'abort'] as const;

/**
 * End the run because the user gave up on the stage.
 *
 * The run ends with a blocker on record: a run that was given up on is not
 * a run that succeeded.
 */
function abortRun(state: GraphState, reason: string): NodeOutcome {
  return {
    kind: 'advance',
    update: {
      currentStage: 'completed',
      blockers: [
        {
          id: `spec-aborted:${state.runId || state.requirementName || 'run'}`,
          taskId: state.requirementName || 'spec',
          reason: `the spec stage was given up on: ${reason}`,
          createdAt: new Date().toISOString(),
        },
      ],
    },
    goto: 'completed',
  };
}

/** The id of the synthetic question of the "no acceptance criteria" gate. */
const SYNTHETIC_QUESTION_ID = 'Q-NEW';

/**
 * The questions of the clarification gate.
 *
 * The gate asks the open questions - or, when the spec has no acceptance
 * criteria at all, one synthetic question about them.
 */
function questionsOf(exit: SpecExit): SpecQuestion[] {
  const questions: SpecQuestion[] = [...exit.openQuestions];
  if (exit.missingAc) {
    // The spec has no acceptance criteria: the user has to be asked for
    // them, next to the questions the worker could not answer.
    questions.push({
      id: SYNTHETIC_QUESTION_ID,
      question:
        'spec.md has no acceptance criteria (### AC-xxx): which acceptance criteria does this requirement have? (one per line)',
      round: 1,
      status: 'pending',
    });
  }
  return questions;
}

/**
 * The acceptance criteria of the answer of the "no acceptance criteria" gate.
 *
 * The answer may come in three shapes, and all of them have to work:
 *
 * - the answers map of the gate (`{ answers: { 'Q-NEW': '...' } }`),
 * - the bare text of the answer (`{ answer: '...' }` or the text itself),
 * - the answers of the open questions.
 */
function criteriaOf(answers: Record<string, string>, answer: unknown): string {
  const synthetic = answers[SYNTHETIC_QUESTION_ID];
  if (synthetic !== undefined && synthetic.trim() !== '') return synthetic.trim();

  const text = answerSummary(answer);
  if (text !== 'no answer given' && text.trim() !== '') return text.trim();

  return Object.values(answers).join('\n');
}

/** The payload of the clarification gate. */
function questionsPayload(questions: SpecQuestion[], missingAc: boolean): InterruptPayload {
  return {
    audience: 'user',
    type: 'spec_questions',
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      round: question.round,
    })),
    answer: {
      answers: `{ '${questions[0].id}': '<your answer>' }`,
    },
    ...(missingAc ? { message: 'the spec has no acceptance criteria yet' } : {}),
  };
}

/**
 * The answers of the clarification gate.
 *
 * The host may answer with a map (`{ 'Q-001': '...' }`), with a list (the
 * answers of the open questions, in the order they were asked) or with the
 * map at the top level.
 */
function readAnswers(answer: unknown, openQuestions: SpecQuestion[]): Record<string, string> {
  const raw =
    typeof answer === 'object' && answer !== null
      ? (answer as { answers?: unknown }).answers
      : undefined;

  if (Array.isArray(raw)) {
    const answers: Record<string, string> = {};
    raw.forEach((value, index) => {
      const question = openQuestions[index];
      if (question && typeof value === 'string') answers[question.id] = value;
    });
    return answers;
  }

  if (typeof raw === 'object' && raw !== null) {
    return stringMap(raw);
  }

  if (typeof answer === 'object' && answer !== null) {
    return stringMap(answer);
  }

  return {};
}

/** Keep the string entries of an object. */
function stringMap(value: object): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') entries[key] = item;
  }
  return entries;
}

/**
 * The answers of the blocking TBC gate.
 *
 * The host may answer with a map (`{ 'TBC-001': '...' }`) or with a list of
 * `{ id, resolution }`.
 */
function readResolutions(answer: unknown): Record<string, string> {
  const raw =
    typeof answer === 'object' && answer !== null
      ? (answer as { resolutions?: unknown }).resolutions
      : undefined;

  if (Array.isArray(raw)) {
    const resolutions: Record<string, string> = {};
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const id = (item as { id?: unknown }).id;
      const resolution = (item as { resolution?: unknown }).resolution;
      if (typeof id === 'string' && typeof resolution === 'string') {
        resolutions[id] = resolution;
      }
    }
    return resolutions;
  }

  if (typeof raw === 'object' && raw !== null) {
    return stringMap(raw);
  }

  return {};
}

/**
 * Write the answers back into the spec.
 *
 * An answered question becomes `(answered)` and carries the answer; an
 * answer that belongs to no question is appended to a section of its own.
 */
export function applyAnswers(specMd: string, answers: Record<string, string>): string {
  const used = new Set<string>();
  const lines = specMd.split(/\r?\n/).map((line) => {
    const match = QUESTION_LINE_PATTERN.exec(line);
    if (!match) return line;
    const answer = answers[match[1]];
    if (answer === undefined) return line;
    used.add(match[1]);
    const text = match[2].replace(STATUS_MARKER_PATTERN, '').trim();
    return `- [${match[1]}] (answered) ${text}${text === '' ? '' : ' — '}${answer}`;
  });

  const leftovers = Object.entries(answers).filter(([id]) => !used.has(id));
  if (leftovers.length === 0) return lines.join('\n');

  const section = [
    '## Clarification Answers',
    '',
    ...leftovers.map(([, answer]) => `- ${answer}`),
    '',
  ].join('\n');
  return `${lines.join('\n').replace(/\s*$/, '')}\n\n${section}`;
}

/**
 * Write the answers of the "no acceptance criteria" gate into the spec.
 *
 * The answer of the user becomes the acceptance criteria: without them the
 * spec is not a spec, and the stage may not advance.
 *
 * @param specMd - The spec of the run.
 * @param text - The answer of the user (one criterion per line).
 */
export function applyAcceptanceCriteria(specMd: string, text: string): string {
  const criteria = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (criteria.length === 0) return specMd;

  const lines = specMd.split(/\r?\n/);
  let next = nextAcNumber(specMd);
  const entries = criteria.map(
    (criterion) => `### AC-${String(next++).padStart(3, '0')}: ${criterion}`
  );

  const heading = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line));
  if (heading < 0) {
    const section = ['## Acceptance Criteria', '', ...entries, ''].join('\n');
    return `${specMd.replace(/\s*$/, '')}\n\n${section}`;
  }

  const rest = lines.slice(heading + 1);
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  return [...lines.slice(0, heading + 1), '', ...entries, '', ...rest].join('\n');
}

/** The next free acceptance criterion number of a document. */
function nextAcNumber(specMd: string): number {
  let highest = 0;
  for (const match of specMd.matchAll(/AC-(\d{3})/g)) {
    const number = Number(match[1]);
    if (number > highest) highest = number;
  }
  return highest + 1;
}

/**
 * Write the resolutions of the blocking TBCs back into the spec.
 *
 * A resolved TBC carries `(resolved: ...)` - that is how the parser
 * recognises it as answered.
 */
export function applyResolutions(specMd: string, resolutions: Record<string, string>): string {
  const lines = specMd.split(/\r?\n/).map((line) => {
    const match = TBC_LINE_PATTERN.exec(line);
    if (!match) return line;
    const resolution = resolutions[match[1]];
    if (resolution === undefined) return line;
    const blocking = match[2].trim().startsWith('(blocking)') ? '(blocking) ' : '';
    const text = match[2].replace(BLOCKING_MARKER_PATTERN, '').trim();
    return `- [${match[1]}] ${blocking}(resolved: ${resolution}) ${text}`;
  });
  return lines.join('\n');
}

/**
 * Turn the questions nobody answered into TBCs.
 *
 * A question that survives three rounds is not a question anymore - it is
 * an open item, and it blocks the stage like every other blocking TBC.
 */
export function questionsToTbc(
  specMd: string,
  questions: SpecQuestion[]
): { text: string; tbcs: TBCItem[] } {
  const ids = new Set(questions.map((question) => question.id));
  const tbcs: TBCItem[] = [];
  let next = nextTbcNumber(specMd);

  const lines = specMd.split(/\r?\n/).map((line) => {
    const match = QUESTION_LINE_PATTERN.exec(line);
    if (!match || !ids.has(match[1])) return line;
    const id = `TBC-${String(next).padStart(3, '0')}`;
    next += 1;
    const text = match[2].replace(STATUS_MARKER_PATTERN, '').trim();
    tbcs.push({
      id,
      description: text,
      blocking: true,
      resolved: false,
      createdAt: new Date().toISOString(),
    });
    return `- [${id}] (blocking) ${text}`;
  });

  return { text: lines.join('\n'), tbcs };
}

/** The next free TBC number of a document. */
function nextTbcNumber(specMd: string): number {
  let highest = 0;
  for (const match of specMd.matchAll(/TBC-(\d{3})/g)) {
    const number = Number(match[1]);
    if (number > highest) highest = number;
  }
  return highest + 1;
}

/** The TBC that says there was no Figma file to fetch. */
function noFigmaUrlTbc(): TBCItem {
  return {
    id: 'TBC-FIGMA-NO-URL',
    description: 'the Figma files were asked for, but no Figma file was given',
    blocking: false,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The TBC that says the spec writer did not finish.
 *
 * It is **not blocking**: a worker that failed has not written a spec at
 * all, so the reading fails too - the stage re-issues the work order and
 * asks the user when the second attempt fails as well. The TBC is the
 * record of what happened, not a gate of its own.
 */
function orderFailedTbc(result: unknown): TBCItem {
  return workerFailedTbc('TBC-SPEC-ORDER', 'spec writer', result);
}

/**
 * Read the spec of a run.
 *
 * A spec that does not exist reads as an empty document; a spec that exists
 * but cannot be read is an error - a broken document is not an empty one.
 */
function readSpec(docsDir: string): string {
  return readDoc(path.join(docsDir, 'spec.md'));
}

/** Write the spec of a run. */
function writeSpec(docsDir: string, text: string): void {
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'spec.md'), text, 'utf-8');
}

/** `- [Q-001] <rest>` - a clarification question. */
const QUESTION_LINE_PATTERN = /^\s*[-*]\s+\[(Q-\d{3})\]\s*(.*)$/;

/** `- [TBC-001] <rest>` - a to-be-confirmed item. */
const TBC_LINE_PATTERN = /^\s*[-*]\s+\[(TBC-\d{3})\]\s*(.*)$/;

/** `(answered)` / `(tbc)` / `(pending)` - the status of a question. */
const STATUS_MARKER_PATTERN = /^\((answered|tbc|pending)\)\s*/i;

/** `(blocking)` - whether a TBC blocks the stage. */
const BLOCKING_MARKER_PATTERN = /^\(blocking\)\s*/i;
