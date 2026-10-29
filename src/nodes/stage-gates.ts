import { interrupt } from '@langchain/langgraph';
import { answerText, workerQuestion } from '../cli/protocol.js';
import type { WorkerQuestion } from '../cli/protocol.js';
import { hasStageStep, readStageStep, recordStageStep } from '../graph/state.js';
import type { GraphState, NodeOutcome } from '../graph/state.js';
import type { TBCItem } from '../state/types.js';

/**
 * The gates every stage node shares.
 *
 * A worker that hit a decision it may not make answers with
 * `status: 'needs_human'` and states the question in the result. The worker
 * may not ask the user itself - the graph turns the question into a gate of
 * the `user` audience, and the answer goes back into the state.
 *
 * The handling is the same in every stage: the PRD stage, the spec stage,
 * the e2e plan stage and the task split stage.
 */

/** What a stage needs to know about the question of a worker. */
export interface WorkerQuestionOptions {
  /** The stage that owns the order. */
  stage: string;
  /** The step that holds the question. */
  step: string;
  /** The step that records the answer of the user. */
  answeredStep: string;
  /** The type of the gate (the host routes on it). */
  type: string;
  /** The node the stage routes back into. */
  goto: string;
  /** The id of the TBC that records the answer. */
  tbcId: string;
}

/**
 * The state update that records the question a worker raised.
 *
 * @param result - The value the work order was completed with.
 * @param opts - Where the question goes.
 * @returns The update, or `undefined` when the worker raised no question.
 */
export function recordWorkerQuestion(
  result: unknown,
  opts: Pick<WorkerQuestionOptions, 'stage' | 'step'>
): Partial<GraphState> | undefined {
  const question = workerQuestion(result);
  if (question === undefined) return undefined;
  return recordStageStep(opts.stage, opts.step, JSON.stringify(question));
}

/**
 * The gate that asks the user the question a worker raised.
 *
 * @param state - The graph state.
 * @param opts - Where the question is and where the answer goes.
 * @returns The outcome of the gate, or `undefined` when there is nothing to ask.
 */
export function askWorkerQuestion(
  state: GraphState,
  opts: WorkerQuestionOptions
): NodeOutcome | undefined {
  const raised = readStageStep(state, opts.stage, opts.step);
  if (raised === undefined) return undefined;
  if (hasStageStep(state, opts.stage, opts.answeredStep)) return undefined;

  const question = JSON.parse(raised) as WorkerQuestion;
  const answer = interrupt({
    audience: 'user',
    type: opts.type,
    question: question.question,
    options: question.options,
    // The gate has to say what an answer looks like: a worker question
    // whose answer is dropped is a question the user answered for nothing.
    answer: {
      answer: '<your answer>',
      options: '<one of the options above, if there are any>',
    },
  });

  const update = recordStageStep(opts.stage, opts.answeredStep, '');
  update.tbcItems = [
    {
      id: opts.tbcId,
      description: `the user answered the question of the worker (${question.question}): ${answerSummary(answer)}`,
      blocking: false,
      resolved: true,
      createdAt: new Date().toISOString(),
    },
  ];
  return { kind: 'advance', update, goto: opts.goto };
}

/**
 * The TBC that says a worker did not finish.
 *
 * Every stage records the failure of its worker the same way: the reason
 * the worker gave, and the question it raised (a worker that asks a
 * question it may not answer itself leaves the question behind).
 *
 * The TBC is **not blocking**: a worker that failed has not written its
 * document, so the stage re-issues the work order and asks the user when
 * the second attempt fails as well. The TBC is the record of what happened,
 * not a gate of its own.
 *
 * @param id - The id of the TBC (one per stage).
 * @param noun - What the worker is called (`spec writer`, ...).
 * @param result - The value the work order was completed with.
 */
export function workerFailedTbc(id: string, noun: string, result: unknown): TBCItem {
  const summary =
    typeof result === 'object' && result !== null
      ? (result as { summary?: unknown }).summary
      : undefined;
  const question =
    typeof result === 'object' && result !== null
      ? (result as { interrupt?: { question?: unknown } }).interrupt?.question
      : undefined;
  const because = typeof summary === 'string' && summary !== '' ? summary : 'no reason given';
  const asked = typeof question === 'string' && question !== '' ? ` (it asked: ${question})` : '';
  return {
    id,
    description: `the ${noun} did not finish: ${because}${asked}`,
    blocking: false,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/** What the user answered with. */
export function answerSummary(answer: unknown): string {
  if (typeof answer === 'string' && answer.trim() !== '') return answer.trim();
  const text = answerText(answer, 'answer') || answerText(answer, 'comment');
  return text === '' ? 'no answer given' : text;
}
