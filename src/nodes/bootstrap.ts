import * as fs from 'fs';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import {
  detectStartBlocker,
  readRunId,
  startTask,
} from '../commands/start-task.js';
import type { StartTaskBlocker, StartTaskResult } from '../commands/start-task.js';
import { acquireLock, forceUnlock, getLock } from '../runtime/branch-lock.js';
import { getLockFilePath, getRepoDir } from '../runtime/paths.js';
import { generateBranchName, normalizeTaskName } from '../runtime/task-name.js';
import { cleanupTaskWorkspace } from '../runtime/task-workspace.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';

/**
 * The bootstrap node: the deterministic setup of a run.
 *
 * It is **one** node, not six (validate / lock / clone / ...): `startTask()`
 * already is that flow, and splitting it would put the "clone failed, retry"
 * logic into the graph's edges instead of into one place that can be tested.
 *
 * **How it asks the user.** LangGraph v1 has no `Command({ interrupt })`; the
 * only way to park a run is `interrupt(payload)` *inside* the node body. The
 * first execution throws and parks the run, the next execution returns the
 * answer.
 *
 * **A node may ask at most once per execution.** Every `interrupt()` call
 * takes the *next* queued answer, so a second call in the same execution
 * would swallow the user's next answer instead of parking again - the run
 * would fall out of the gate instead of asking the same question again. A
 * node that has to ask twice therefore routes back into itself
 * (`goto: 'bootstrap'`): the next execution starts over and asks again.
 *
 * **The order of the steps matters.** Everything the node does before its
 * `interrupt()` runs twice - once before the run parks and once after the
 * answer arrives - so the checks that decide whether the user has to be
 * asked are read-only.
 */

/** How many times the node tries the clone before it asks the user. */
const MAX_ATTEMPTS = 3;

/** Options of {@link bootstrapNode}. */
export interface BootstrapOptions {
  /** Branch lock file. Defaults to the plugin-root lock. */
  lockPath?: string;
}

/**
 * Prepare the workspace of a run and hand it over to the PRD stage.
 *
 * @param state - The graph state (`requirementName`, `repoUrl`).
 * @param opts - Options (the lock file the run uses).
 */
export async function bootstrapNode(
  state: GraphState,
  opts: BootstrapOptions = {}
): Promise<NodeOutcome> {
  const lockPath = opts.lockPath ?? getLockFilePath();
  const normalizedTaskName = normalizeTaskName(state.requirementName);
  const branch = generateBranchName(normalizedTaskName);

  // Has this execution already asked the user something?
  let asked = false;

  // ---- Step 1: does the user have to decide anything? -------------------
  // Read-only: the checks below touch neither the lock nor the workspace.
  const blocker = detectStartBlocker(normalizedTaskName, lockPath);
  if (blocker) {
    const action = actionOf(interrupt(payloadFor(blocker)));
    asked = true;

    if (blocker.kind === 'lock_conflict') {
      if (!settleLockConflict(action, lockPath)) {
        // The lock is still held → the same question has to be asked again,
        // and that happens in the next execution.
        return askAgain();
      }
    } else if (action === 'reset') {
      // 'reset': throw the old workspace away and start over.
      cleanupTaskWorkspace(normalizedTaskName);
    } else if (repoIsCloned(normalizedTaskName)) {
      // 'resume': keep the workspace the previous run prepared.
      return adoptWorkspace(normalizedTaskName, branch, lockPath);
    } else {
      // 'resume', but the previous run never finished its clone: the repo
      // directory is an empty shell. Only that shell is thrown away - the
      // rest of the workspace (the run metadata) belongs to this task and is
      // kept - and the clone is done again below.
      fs.rmSync(getRepoDir(normalizedTaskName), { recursive: true, force: true });
    }
  }

  // ---- Step 2: the deterministic work -----------------------------------
  for (let attempt = 1; ; attempt += 1) {
    const result = await startTask(state.requirementName, state.repoUrl, { lockPath });
    if (result.success) {
      return advance(result);
    }

    if (result.errorCode === 'lock_conflict') {
      // **The lock gate.** The acquisition inside `startTask` can fail for
      // the same reason the pre-check above does, so it opens the *same*
      // gate: one gate, one payload, and the user can always pick
      // `stop_other`.
      if (!asked) {
        const action = actionOf(
          interrupt(payloadFor(lockBlocker(result.holderTaskName, result.error)))
        );
        asked = true;
        settleLockConflict(action, lockPath);
      }
      // Whatever the answer was, the next execution starts over with a fresh
      // retry budget - and its pre-check decides whether the lock is still in
      // the way.
      return askAgain();
    }

    if (!isRetryable(result) || attempt >= MAX_ATTEMPTS) {
      // Out of retries (or an error that will not get better by trying
      // again): the user decides. This is the ONE interrupt of this
      // execution - if the user already answered a gate above, the next
      // execution asks again.
      if (!asked) {
        interrupt(failurePayload(result));
      }
      // The answer arrived (the user approved): the next execution tries
      // again, with a fresh retry budget.
      return askAgain();
    }
  }
}

/**
 * Act on the answer of the lock gate.
 *
 * `stop_other` takes the lock away from whoever holds it; `wait` does
 * nothing and waits for the other task to finish.
 *
 * @returns true when the lock is free and the setup may continue.
 */
function settleLockConflict(action: string | undefined, lockPath: string): boolean {
  if (action === 'stop_other') {
    // The user took the lock away from whoever holds it.
    const forced = forceUnlock(lockPath);
    if (!forced.success) {
      // The lock file could not be removed: nothing else can be done here.
      // The next execution asks about the lock again - the user can fix the
      // file and approve once more, or wait.
      return false;
    }
  }
  // 'wait': the setup may only continue when the lock is actually free.
  const lock = getLock(lockPath);
  return !lock?.running;
}

/**
 * Take over a workspace a previous run prepared.
 *
 * The run has to own the branch lock: the workspace alone is not enough,
 * another task may be working on another branch right now.
 */
function adoptWorkspace(
  normalizedTaskName: string,
  branch: string,
  lockPath: string
): NodeOutcome {
  const repoPath = getRepoDir(normalizedTaskName);
  const runId = readRunId(normalizedTaskName);

  const lock = getLock(lockPath);
  if (!lock?.running) {
    // The lock is free: take it. (A lock held by somebody else was already
    // asked about in the gate above - the lock is either free or ours.)
    const acquired = acquireLock(normalizedTaskName, branch, repoPath, runId, lockPath);
    if (!acquired.success) {
      // The lock could not be taken: the run must not advance without it.
      // The next execution asks the user about the lock.
      return askAgain();
    }
  }

  return {
    kind: 'advance',
    update: {
      bootstrapped: true,
      currentStage: 'prd',
      requirementName: normalizedTaskName,
      repoPath,
      branch,
      runId,
    },
    goto: 'prd',
  };
}

/** The outcome of a successful start. */
function advance(result: StartTaskResult): NodeOutcome {
  return {
    kind: 'advance',
    update: {
      bootstrapped: true,
      currentStage: 'prd',
      requirementName: result.normalizedTaskName,
      repoPath: result.repoPath,
      branch: result.branch,
      runId: result.runId,
    },
    goto: 'prd',
  };
}

/**
 * Ask the same question again - in the next execution.
 *
 * The node cannot raise a second interrupt in the same execution (it would
 * take the user's next answer instead of parking), so it routes back into
 * itself: the next execution starts over and asks again.
 */
function askAgain(): NodeOutcome {
  return { kind: 'advance', update: {}, goto: 'bootstrap' };
}

/** The payload of the gate that asks the user about a blocker. */
function payloadFor(blocker: StartTaskBlocker): InterruptPayload {
  if (blocker.kind === 'lock_conflict') {
    return {
      audience: 'user',
      type: 'lock_conflict',
      code: 'lock_conflict',
      options: ['wait', 'stop_other'],
      ...(blocker.holderTaskName ? { holder: blocker.holderTaskName } : {}),
      ...(blocker.message ? { message: blocker.message } : {}),
    };
  }
  return { audience: 'user', type: 'already_exists', options: ['resume', 'reset'] };
}

/**
 * The lock conflict of an internal acquisition failure.
 *
 * The message of the failed attempt is carried over: the user has to be able
 * to tell *why* the lock could not be taken (e.g. the lock file is not
 * writable) - the gate alone does not say that.
 */
function lockBlocker(holderTaskName: string | undefined, message: string | undefined): StartTaskBlocker {
  return { kind: 'lock_conflict', holderTaskName: holderTaskName ?? '', message };
}

/** The payload of the gate that reports a failure the retries did not fix. */
function failurePayload(result: StartTaskResult): InterruptPayload {
  return {
    audience: 'user',
    type: 'bootstrap_failed',
    code: result.errorCode,
    message: result.error,
  };
}

/**
 * The action the user answered with (`{ action: 'resume' }` or `'resume'`).
 */
export function actionOf(answer: unknown): string | undefined {
  if (typeof answer === 'string') return answer;
  if (typeof answer === 'object' && answer !== null) {
    const action = (answer as { action?: unknown }).action;
    if (typeof action === 'string') return action;
  }
  return undefined;
}

/** Did a previous run really clone the repository? */
function repoIsCloned(normalizedTaskName: string): boolean {
  return fs.existsSync(path.join(getRepoDir(normalizedTaskName), '.git'));
}

/** Are these the errors a retry can fix? */
function isRetryable(result: StartTaskResult): boolean {
  return result.errorCode === 'git_error' || result.errorCode === 'network_error';
}
