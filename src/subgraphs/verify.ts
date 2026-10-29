import { interrupt } from '@langchain/langgraph';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import { actionOf } from '../nodes/bootstrap.js';
import { checkLogPath, runCheck, VERIFY_CHECKS } from '../nodes/verify-checks.js';
import type { CheckRunner } from '../nodes/verify-checks.js';
import { getDocsDir } from '../runtime/paths.js';
import type { Blocker, VerificationCheck } from '../state/types.js';

/**
 * The verification stage: four deterministic gates, no LLM.
 *
 * The gates run in a fixed order (`lint:ts` → `lint` → `test` → `e2e`) and
 * stop at the first one that fails - a type error makes the test result
 * meaningless, and a failing test makes the e2e run meaningless. The gates
 * behind the failure stay `pending` in the state.
 *
 * **The node never touches the business code.** It runs commands and records
 * what it saw. The only thing that writes is `eslint --fix`, and that is the
 * command's own doing, not the node's.
 *
 * **Why the node runs itself three times.** `interrupt()` has to live inside
 * the node body, and LangGraph re-executes the whole node when the run is
 * resumed - so everything the node does before its `interrupt()` happens
 * twice. The gates are exactly what must not happen twice: `eslint --fix`
 * rewrites source files, `jest` writes new snapshots, `playwright` writes
 * `test-results/`.
 *
 * The node therefore splits its work over three executions and leaves the
 * result of the gates in the **state** (the `verification.checks` channel):
 *
 * 1. nothing recorded yet → write the four gates as `'pending'`, go to
 *    `verify` again;
 * 2. the gates are `'pending'` → run them, write down what they said, go to
 *    `verify` again;
 * 3. the results are on record → ask the user (or finish the run).
 *
 * The gates therefore run **once per pass**, and the execution that asks
 * the user does nothing but read the state and raise the interrupt.
 *
 * The routing decision is made from the **recorded** result, never from a
 * fresh run: a gate that failed is a fact of this pass, and the answer of
 * the user belongs to that fact.
 */

/** What the user can answer when a gate failed. */
export type VerifyFailureAction = 'manual' | 'skip' | 'abort';

/** How often a failing gate is retried before the user is asked. */
export const MAX_CHECK_RETRIES = 2;

/** Options of {@link verifySubgraph}. */
export interface VerifyOptions {
  /** The runner that executes the commands (the tests inject a fake one). */
  runner?: CheckRunner;
  /** Budget of one attempt. Defaults to 120 s. */
  timeoutMs?: number;
}

/**
 * Where the run goes after the user answered a failed gate.
 *
 * - `manual`: the user repairs the code themselves - the run goes back to
 *   the TDD stage, which hands out a developer work order.
 * - `skip`: the remaining gates are dropped and the run ends.
 * - `abort`: the run ends as well, but the node records a blocker, so the
 *   run is not reported as cleanly completed.
 *
 * The function is pure: recording the blocker is the node's business, not
 * the routing's.
 */
export function routeAfterFailure(action: VerifyFailureAction): 'tdd' | 'completed' {
  return action === 'manual' ? 'tdd' : 'completed';
}

/**
 * The verification node.
 *
 * @param state - The graph state (`repoPath`, `requirementName`).
 * @param opts - The runner and the budget of the gates.
 * @throws Error when the run has no repository yet - the gates would run in
 * the wrong directory.
 */
export async function verifySubgraph(
  state: GraphState,
  opts: VerifyOptions = {}
): Promise<NodeOutcome> {
  const repoDir = state.repoPath;
  if (!repoDir) {
    throw new Error('the verification stage needs a repository path');
  }
  const docsDir = getDocsDir(state.requirementName, repoDir);

  const recorded = state.verification?.checks ?? [];

  // ---- Pass 1: nothing has run yet -------------------------------------
  // The gates are marked as pending, so that the next execution knows it is
  // the one that has to run them.
  if (recorded.length === 0) {
    return {
      kind: 'advance',
      update: { verification: { checks: pendingChecks() } },
      goto: 'verify',
    };
  }

  // ---- Pass 2: run the gates -------------------------------------------
  // The result is written to the state before anybody is asked anything, so
  // that the question is asked about the run that actually failed.
  if (recorded.every((check) => check.status === 'pending')) {
    const checks = await runGates(repoDir, docsDir, opts);
    return { kind: 'advance', update: { verification: { checks } }, goto: 'verify' };
  }

  // ---- Pass 3: the result is on record ---------------------------------
  const failed = recorded.filter((check) => check.status === 'failed');
  if (failed.length === 0) {
    return { kind: 'advance', update: { currentStage: 'completed' }, goto: 'completed' };
  }

  // The one gate of this node, and the first thing this execution does:
  // nothing before it may have a side effect, because the node runs again
  // when the run is resumed.
  const answer = interrupt(payloadFor(failed, docsDir));
  const action = actionOf(answer);
  const target = routeAfterFailure(normalizeAction(action));

  const update: Partial<GraphState> = { currentStage: target };
  if (target === 'tdd') {
    // The next pass starts from scratch: the gates have to run again, and
    // the result of this pass must not be mistaken for the next one.
    update.verification = { checks: pendingChecks() };
  } else {
    // The run ends with a failure on record. `skip` and `abort` both end the
    // run, and both leave a blocker - neither of them may be mistaken for a
    // run that passed every gate.
    update.blockers = [blockerFor(action, failed, state)];
  }

  return { kind: 'advance', update, goto: target };
}

/** The gates of a pass that has not run yet. */
function pendingChecks(): VerificationCheck[] {
  return VERIFY_CHECKS.map((spec) => ({ name: spec.name, status: 'pending', retries: 0 }));
}

/**
 * Run the gates in order.
 *
 * A gate that fails is retried up to {@link MAX_CHECK_RETRIES} times. A
 * gate that can repair itself (`eslint --fix`) reports `fixed` when the
 * second run is clean.
 */
async function runGates(
  repoDir: string,
  docsDir: string,
  opts: VerifyOptions
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const runOptions = { docsDir, timeoutMs: opts.timeoutMs, runner: opts.runner };

  for (const spec of VERIFY_CHECKS) {
    let retries = 0;
    let result = await runCheck(spec.name, repoDir, runOptions);
    while (result.status === 'failed' && retries < MAX_CHECK_RETRIES) {
      retries += 1;
      result = await runCheck(spec.name, repoDir, runOptions);
    }

    checks.push({
      name: spec.name,
      status: result.status,
      retries,
      lastRunAt: new Date().toISOString(),
      ...(result.status === 'failed' ? { error: summarize(result.log, result.exitCode) } : {}),
    });

    if (result.status === 'failed') {
      // The gates behind a failed one are not run - their result would be
      // noise, not information.
      for (const rest of VERIFY_CHECKS.slice(checks.length)) {
        checks.push({ name: rest.name, status: 'pending', retries: 0 });
      }
      break;
    }
  }

  return checks;
}

/** The payload of the gate that asks the user what to do with a failure. */
function payloadFor(failed: VerificationCheck[], docsDir: string): InterruptPayload {
  return {
    audience: 'user',
    type: 'verify_failed',
    failed: failed.map((check) => check.name),
    options: ['manual', 'skip', 'abort'],
    // Where the logs are: the user has to be able to read them.
    logs: Object.fromEntries(
      failed.map((check) => [check.name, checkLogPath(docsDir, check.name)])
    ),
  };
}

/**
 * The action of the answer.
 *
 * An answer the node does not understand is treated like `abort`: the run
 * stops and a blocker says what happened.
 */
function normalizeAction(action: string | undefined): VerifyFailureAction {
  if (action === 'manual' || action === 'skip' || action === 'abort') return action;
  return 'abort';
}

/**
 * The blocker of a run that ended with a failed gate.
 *
 * The id is unique per blocker, not a constant: the blockers of a state are
 * merged by their id, so a constant id would make the second blocker
 * replace the first one.
 */
function blockerFor(
  action: string | undefined,
  failed: VerificationCheck[],
  state: GraphState
): Blocker {
  const gates = failed.map((check) => check.name).join(', ');
  const label = (action ?? 'unknown').replace(/[^a-z0-9_-]/gi, '');
  return {
    // **The id is derived, not stamped.** The blockers of a state are merged
    // by their id: an id that changes on every call piles blockers up
    // instead of replacing them, so a run that fails the same gate twice
    // would report two near-identical blockers. The failed gates are part
    // of the id: the same failure replaces itself, a different one is a
    // different blocker.
    id: `verify-${label || 'unknown'}:${state.runId || state.requirementName || 'run'}:${gates}`,
    taskId: state.tasks[state.currentTaskIndex]?.id ?? 'verification',
    reason: reasonFor(action, gates),
    createdAt: new Date().toISOString(),
  };
}

/** Why the run ended with a failed gate. */
function reasonFor(action: string | undefined, gates: string): string {
  if (action === 'skip') {
    return `the verification stage was skipped by the user (failed gates: ${gates})`;
  }
  if (action === 'abort') {
    return `the verification stage was aborted by the user (failed gates: ${gates})`;
  }
  return (
    `the verification stage was answered with '${action ?? 'nothing'}', which is not one of ` +
    `manual|skip|abort; the run was stopped (failed gates: ${gates})`
  );
}

/** The reason a gate failed, in one line. */
function summarize(log: string, exitCode: number): string {
  const lines = log.split('\n');
  const reasons: string[] = [];
  let inStderr = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '[stderr]') {
      inStderr = true;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('[stdout]') || line.startsWith('[status]')) {
      inStderr = false;
      continue;
    }
    if (inStderr && line.length > 0) reasons.push(line);
  }
  return reasons[reasons.length - 1] ?? `the gate failed (exit code ${exitCode})`;
}
