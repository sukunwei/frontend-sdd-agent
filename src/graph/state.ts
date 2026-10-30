import { Annotation, Command } from '@langchain/langgraph';
import type {
  Approvals,
  ArtifactIndex,
  Blocker,
  ReviewResult,
  SddState,
  Stage,
  Task,
  TBCItem,
  TddSubStage,
} from '../state/types.js';
import { mergeBlockers, mergeById, mergeRecord, mergeVerification } from './reducers.js';
import type { VerificationState } from './reducers.js';

/**
 * The LangGraph annotation of the SDD workflow state.
 *
 * **Every field carries a reducer.** LangGraph's `getChannel()` falls through
 * to `LastValue` when a field has neither a `reducer` nor a `value`, and a
 * `LastValue` channel silently drops the `default` — the field then never
 * shows up in the state at all. Writing `reducer: (_p, n) => n` everywhere
 * keeps the defaults alive.
 */
export const SddStateAnnotation = Annotation.Root({
  version: Annotation<'1.1.0'>({ reducer: (_p, n) => n, default: () => '1.1.0' }),
  requirementName: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  repoUrl: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  repoPath: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  branch: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  runId: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  bootstrapped: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  currentStage: Annotation<Stage>({ reducer: (_p, n) => n, default: () => 'bootstrap' }),
  artifacts: Annotation<ArtifactIndex>({ reducer: mergeRecord, default: () => ({}) }),
  stageSteps: Annotation<Record<string, string>>({ reducer: mergeRecord, default: () => ({}) }),
  tbcItems: Annotation<TBCItem[]>({ reducer: mergeById, default: () => [] }),
  tasks: Annotation<Task[]>({ reducer: mergeById, default: () => [] }),
  currentTaskIndex: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  tddSubStage: Annotation<TddSubStage>({ reducer: (_p, n) => n, default: () => 'pending' }),
  lastReviews: Annotation<ReviewResult[]>({ reducer: (_p, n) => n, default: () => [] }),
  tddAttempts: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  verification: Annotation<VerificationState>({ reducer: mergeVerification, default: () => ({ checks: [] }) }),
  blockers: Annotation<Blocker[]>({ reducer: mergeBlockers, default: () => [] }),
  approvals: Annotation<Approvals>({ reducer: mergeRecord, default: () => ({}) }),
  createdAt: Annotation<string>({ reducer: (_p, n) => n, default: () => new Date().toISOString() }),
  updatedAt: Annotation<string>({ reducer: (_p, n) => n, default: () => new Date().toISOString() }),
});

/** The state as the graph sees it. */
export type GraphState = typeof SddStateAnnotation.State;

/**
 * Compile-time proof that the annotation and the hand-written `SddState`
 * describe the same document. If either side drifts, this alias stops
 * compiling.
 */
const _assertShape: SddState = null as unknown as typeof SddStateAnnotation.State;

/**
 * Payload of a pending interrupt.
 *
 * It is what a node hands to `interrupt()` inside its own body. Every
 * payload carries a `type` and an `audience` (`'user'` = ask a human,
 * `'host'` = work an order) - the CLI routes the two apart. Task 4 mirrors
 * this in a zod schema (`src/cli/protocol.ts`).
 */
export type InterruptPayload = {
  type: string;
  audience: 'user' | 'host';
  [k: string]: unknown;
};

/**
 * What a node returns.
 *
 * Nodes never return a `Command` directly: a discriminated union lets node
 * tests assert `outcome.kind` and `outcome.goto` without stringifying a
 * LangGraph object.
 *
 * **Interrupts are raised inline, not through this union.** A node that needs
 * an answer calls `interrupt(payload)` inside its own body and uses the value
 * it returns - see {@link toCommand} for why.
 */
export type NodeOutcome = { kind: 'advance'; update: Partial<GraphState>; goto: string };

/**
 * What a node may return.
 *
 * **Only a routing outcome.** A bare state update is not accepted: every
 * node of this graph routes with `Command({ goto })` and no node has a static
 * edge to fall back on, so a bare update would end the run without a trace.
 */
export type NodeResult = NodeOutcome;

/** A graph node. */
export type NodeFn = (state: GraphState) => NodeResult | Promise<NodeResult>;

/**
 * Convert a node outcome into the `Command` LangGraph expects.
 *
 * `advance` becomes `new Command({ update, goto })`.
 *
 * There is deliberately no interrupt branch. LangGraph v1 has no
 * `Command({ interrupt })`: the only way to raise a pending interrupt is
 * `interrupt(value)`, and that call has to happen **inside the node body**,
 * because on resume LangGraph re-executes the whole node function and
 * `interrupt()` then *returns* the answer instead of throwing. A node that
 * raised the interrupt after its body had finished would raise it on the
 * wrong side of the resume and could never consume the answer.
 *
 * **Ordering rule.** `interrupt()` must be the FIRST thing a node does.
 * Everything before it (a file write, a counter, an API call) runs twice:
 * once before the run parks and once after the answer arrives.
 */
export function toCommand(outcome: NodeOutcome): Command {
  return new Command({ update: outcome.update, goto: outcome.goto });
}

/* ------------------------------------------------------------------ */
/* the stage ledger                                                    */
/* ------------------------------------------------------------------ */

/**
 * The stage nodes keep their progress in the `stageSteps` channel.
 *
 * A stage needs more than one answer from the outside: the PRD stage asks
 * the user for the requirements, maybe hands out a Figma work order and
 * finally asks for a confirmation. **A node may raise one interrupt per
 * execution** (a second `interrupt()` would swallow the next queued answer
 * instead of parking again), so the steps of a stage are spread over several
 * executions, and the node has to know which step it is on.
 *
 * The state has no per-stage field, so the progress goes into its own
 * channel: one entry per step, keyed `<stage>/<step>`, whose value is the
 * payload of the step (the Figma URL a user gave, the reading of the
 * documents, ...).
 *
 * **The channel is deliberately not the `artifacts` channel.** The artifacts
 * index the files a run produced: its `path` is a path, and something that
 * walks the artifacts (an artifact report, a timeline writer, a
 * verification gate) has to be able to trust it. The ledger is the graph's
 * own bookkeeping, so it lives next to the artifacts, not inside them.
 *
 * The channel is also not part of the 1.1.0 document: `workflow-state.json`
 * is the mirror of the 1.1.0 schema, and the ledger is not part of it (the
 * checkpoint holds it).
 */
export function stageStepKey(stage: string, step: string): string {
  return `${stage}/${step}`;
}

/** Has this step been taken? */
export function hasStageStep(state: GraphState, stage: string, step: string): boolean {
  return state.stageSteps?.[stageStepKey(stage, step)] !== undefined;
}

/** The payload of a step; `undefined` when the step was never taken. */
export function readStageStep(state: GraphState, stage: string, step: string): string | undefined {
  return state.stageSteps?.[stageStepKey(stage, step)];
}

/** The state update that records a step. */
export function recordStageStep(stage: string, step: string, payload = ''): Partial<GraphState> {
  return { stageSteps: { [stageStepKey(stage, step)]: payload } };
}

/* ------------------------------------------------------------------ */
/* the generations of a stage                                          */
/* ------------------------------------------------------------------ */

/** The step that holds the generation counter of a stage. */
const GENERATION_STEP = 'generation';

/**
 * The generation of a stage.
 *
 * A stage that reads documents it does not write (the worker writes them)
 * has to keep its reading: the documents change between the execution that
 * parks and the one that resumes it, and a node that decides by reading them
 * again would take a different branch - the answer of the user would be
 * handed to the wrong interrupt.
 *
 * A generation counts the times the stage went back to the beginning: every
 * change of the documents, every rejected document. The reading of a
 * generation is stored under `<stage>/exit-<generation>`, and the steps
 * that belong to one generation carry its number (`<stage>/<step>-<gen>`).
 */
export function stageGeneration(state: GraphState, stage: string): number {
  const raw = readStageStep(state, stage, GENERATION_STEP);
  if (raw === undefined) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** The step that holds the reading of a generation of a stage. */
export function stageReadingKey(stage: string, generation: number): string {
  return `exit-${generation}`;
}

/** Put the reading of a generation on record. */
export function recordStageReading(
  stage: string,
  generation: number,
  reading: unknown
): Partial<GraphState> {
  return recordStageStep(stage, stageReadingKey(stage, generation), JSON.stringify(reading));
}

/** The reading of a generation, if it is on record. */
export function readStageReading<T>(
  state: GraphState,
  stage: string,
  generation: number
): T | undefined {
  const raw = readStageStep(state, stage, stageReadingKey(stage, generation));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Add the next generation to a state update. */
export function withNextGeneration(
  stage: string,
  generation: number,
  update: Partial<GraphState>
): Partial<GraphState> {
  const bump = recordStageStep(stage, GENERATION_STEP, String(generation + 1));
  return {
    ...update,
    stageSteps: { ...(update.stageSteps ?? {}), ...(bump.stageSteps ?? {}) },
  };
}
