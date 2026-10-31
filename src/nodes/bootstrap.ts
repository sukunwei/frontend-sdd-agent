import * as fs from 'fs';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import {
  detectStartBlocker,
  readRunId,
  startTask,
} from '../commands/start-task.js';
import type { StartTaskBlocker, StartTaskResult } from '../commands/start-task.js';
import { hasStageStep, readStageStep, recordStageStep } from '../graph/state.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import { acquireLock, forceUnlock, getLock, releaseLock } from '../runtime/branch-lock.js';
import { SddAbortError } from '../runtime/errors.js';
import { currentBranchName } from '../runtime/git-branch-manager.js';
import { canonicalRepoRoot, getLockFilePath, getRepoDir } from '../runtime/paths.js';
import { getRunContext, isLocalMode } from '../runtime/run-context.js';
import { generateBranchName, normalizeTaskName } from '../runtime/task-name.js';
import { cleanupTaskWorkspace } from '../runtime/task-workspace.js';

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
 *
 * **就地模式（local）**：程式碼直接寫在使用者的業務倉庫裡，沒有 clone 出來
 * 的副本，所以「倉庫路徑」是使用者的倉庫根（`getRunContext().repoRoot`），
 * 不是 `getRepoDir()`——後者在就地模式指的是 `.sdd/tasks/<task>/repo`，
 * 那只是一個空殼，不是倉庫。
 */

/** How many times the node tries the clone before it asks the user. */
const MAX_ATTEMPTS = 3;

/** The stage this node owns - the ledger key of its steps. */
const STAGE = 'bootstrap';

/**
 * The ledger step that remembers the answer to the dirty-worktree gate.
 *
 * **答案必須記在台賬裡**：LangGraph resume 時整個節點從頭重跑，而
 * `proceed` **不改變世界**——工作區還是髒的。沒有這本帳，第二個執行又會
 * 看到髒、又會再開一次閘門，使用者永遠答不完。
 */
const STEP_DIRTY_WORKTREE = 'dirty-worktree';

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
  const local = isLocalMode();

  // **使用者答過髒工作區了嗎？**（本節點的台賬）
  // 這是本節點唯一會「問第二次」的危險所在：`proceed` 不改變世界，
  // 沒有這本帳，resume 之後的執行會再問一次。
  //
  // **讀「值」而不是「鍵在不在」**：節點級 reset 會把這一步的值清成空字串
  // （`stageSteps` 的 reducer 是合併語義，合併刪不掉一個鍵），
  // 那個鍵還在，但意思是「這一步沒發生過」。
  let dirtyApproved = readStageStep(state, STAGE, STEP_DIRTY_WORKTREE) === 'proceed';

  // Has this execution already asked the user something?
  let asked = false;

  // 節點級 reset 要帶著的台賬變更（「問過了」那一步要清掉）。
  // 空的話 = 沒有要帶的東西 = state 一個鍵都不會多。
  let pendingSteps: Record<string, string> = {};

  /**
   * 把還沒寫進 state 的台賬變更併進結果。
   *
   * **結果自己的台賬優先**：reset 清掉的那一步，若同一個執行裡又有了新的
   * 答案（`proceed`），新答案才是最新的那一步。
   */
  const finish = (outcome: NodeOutcome): NodeOutcome => {
    if (Object.keys(pendingSteps).length === 0) return outcome;
    return {
      ...outcome,
      update: {
        ...outcome.update,
        stageSteps: { ...pendingSteps, ...(outcome.update.stageSteps ?? {}) },
      },
    };
  };

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
        return finish(askAgain());
      }
    } else if (action === 'reset') {
      // 'reset': throw the old workspace away and start over.
      cleanupWorkspace(normalizedTaskName);
      // **台賬也要清**：使用者 reset 的本意是「從頭再來」。若還記著
      // 「使用者已經批准留在當前分支上工作」，下一個執行會靜默地沿用那個
      // 決定（在當前分支上幹活），而不是像 reset 的本意那樣切出新的工作分支。
      //
      // **用空字串當「沒問過」**：`stageSteps` 的 reducer 是合併
      // （`mergeRecord`），合併語義刪不掉一個鍵——把值寫成空字串，
      // 讀取處（`readStageStep(...) === 'proceed'`）就當成「沒答過」。
      //
      // **只清真的記過的那一步**：remote 模式從來沒有記過它，
      // 不清的話 remote 的 state 會多出一個從來沒有的鍵。
      if (hasStageStep(state, STAGE, STEP_DIRTY_WORKTREE)) {
        // **這一次執行也不能沿用舊的決定**：reset 的本意是「從頭再來」，
        // 沿用就變成「靜默地在當前分支上幹活」——那不是使用者要的。
        dirtyApproved = false;
        pendingSteps = {
          ...pendingSteps,
          ...(recordStageStep(STAGE, STEP_DIRTY_WORKTREE, '').stageSteps ?? {}),
        };
      }
    } else if (repoIsCloned(normalizedTaskName)) {
      // 'resume': keep the workspace the previous run prepared.
      return finish(adoptWorkspace(normalizedTaskName, branch, lockPath));
    } else if (local) {
      // 就地模式沒有「clone 了一半的倉庫」：那個空殼本來就不存在。
      // 刪它只是為了清掉舊版本可能留下的殼——刪不掉也不該讓這輪 run 死在這裡，
      // 裡面沒有使用者的任何東西。
      removeRepoShell(normalizedTaskName);
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
    const result = await startTask(state.requirementName, state.repoUrl, {
      lockPath,
      // **使用者已經批准留在當前分支上工作**：不切分支，工作區是髒的也照跑。
      // 這是 `proceed` 的全部意思——使用者的改動原封不動地留在原地。
      ...(local && dirtyApproved ? { skipBranchSwitch: true } : {}),
    });
    if (result.success) {
      return finish(advance(result));
    }

    if (result.errorCode === 'dirty_worktree' && !dirtyApproved) {
      // **髒工作區閘門**：使用者自己正在寫的東西，插件不替他 stash、
      // 不替他帶走——這必須由使用者決定。
      if (asked) {
        // 這一次執行已經問過使用者了（一次執行只能問一次）
        // → 同一個問題留到下一個執行再問。
        return finish(askAgain());
      }
      const action = actionOf(interrupt(dirtyWorktreePayload(normalizedTaskName)));
      if (action === 'proceed') {
        // **把決定記進台賬**，然後回到自己：下一個執行帶著台賬重跑，
        // 就會走「使用者已經批准過」那條路，不會再問第二次。
        return finish({
          kind: 'advance',
          update: recordStageStep(STAGE, STEP_DIRTY_WORKTREE, 'proceed'),
          goto: 'bootstrap',
        });
      }
      if (action === 'abort') {
        // 使用者喊停：checkpoint 留著，使用者還能 resume 這一輪。
        //
        // **只釋放本 task 的鎖**：`releaseLock()` 清的是那個路徑上的**任何**
        // 鎖，不管屬於誰。而這個 run 在閘口處根本還沒拿到鎖（髒檢查在拿鎖
        // 之前就回來了），那把鎖可能是同一個倉庫裡另一個 task 的——
        // 把它清掉，兩個 task 就會同時在一個倉庫裡幹活，
        // 那正是這把鎖存在的理由。
        if (getLock(lockPath)?.taskName === normalizedTaskName) {
          releaseLock(lockPath);
        }
        throw new SddAbortError(
          '使用者中止了這輪運行：工作區有未提交的改動，未建立工作分支。'
        );
      }
      // 認不出的答案 → 再問一次（不能當成放行）。
      return finish(askAgain());
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
      return finish(askAgain());
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
      return finish(askAgain());
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
  const repoPath = repoPathOf(normalizedTaskName);
  const runId = readRunId(normalizedTaskName);
  // **就地模式的分支不是插件自己開的那條**：使用者可能選了「留在當前分支
  // 幹活」，所以要記「真的所在」的分支，後面的流程才知道自己在哪裡。
  const effectiveBranch = isLocalMode() ? currentBranchName(repoPath) : branch;

  const lock = getLock(lockPath);
  if (!lock?.running) {
    // The lock is free: take it. (A lock held by somebody else was already
    // asked about in the gate above - the lock is either free or ours.)
    const acquired = acquireLock(
      normalizedTaskName,
      effectiveBranch,
      repoPath,
      runId,
      lockPath
    );
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
      branch: effectiveBranch,
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

/**
 * The payload of the gate that asks the user about a blocker.
 *
 * **只認得兩種 blocker**（鎖衝突、既有工作區）。髒工作區**不是** blocker——
 * 它是 `startTask()` 回報的一種失敗，所以它有自己的 payload
 * （{@link dirtyWorktreePayload}）：走這條路的閘門若被誤套成
 * `already_exists`，使用者會看到「要 resume 還是 reset」，那跟髒工作區
 * 一點關係都沒有。
 */
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
 * The payload of the gate that asks about a dirty worktree.
 *
 * **問人，不是工作單**：`audience: 'user'` 讓 CLI 走 `approve` 那條路，
 * 而不是把這個閘口當成要 host 去完成的工作。
 *
 * **兩個選項的意思相反到不行**：`proceed` 是「就留在現在這個分支上幹活」，
 * `abort` 是「不幹了」。閘門的訊息要說清楚 `proceed` 會發生什麼事——
 * 使用者是在決定自己的未提交改動會不會被帶到別的分支上。
 */
function dirtyWorktreePayload(normalizedTaskName: string): InterruptPayload {
  const repoPath = repoPathOf(normalizedTaskName);
  const branch = currentBranchName(repoPath);
  return {
    audience: 'user',
    type: 'dirty_worktree',
    code: 'dirty_worktree',
    options: ['proceed', 'abort'],
    message:
      `${repoPath} 的工作區有已跟蹤文件的改動，插件不會自動 stash，` +
      '也不會把這些改動帶到新分支。' +
      `選 proceed：留在當前分支（${branch}）上工作，使用者的改動原封不動；` +
      '選 abort：中止這輪運行。',
  };
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

/**
 * 這輪運行的倉庫路徑。
 *
 * **就地模式是使用者的業務倉庫**：`getRepoDir()` 在就地模式指的是
 * `.sdd/tasks/<task>/repo`——那不是一個倉庫，只是插件自己的空殼，
 * 拿它當倉庫路徑會讓整輪 run 在一個不是倉庫的地方工作。
 *
 * @param normalizedTaskName - 正規化的 task 名
 */
function repoPathOf(normalizedTaskName: string): string {
  return isLocalMode() ? localRepoRoot() : getRepoDir(normalizedTaskName);
}

/**
 * 就地模式的倉庫根（使用者的業務倉庫）。
 *
 * **正規化過的**：macOS 的 `/var` 是 `/private/var` 的符號連結，
 * 未正規化的路徑會讓顯示、比對、鎖的記錄對不上。
 */
function localRepoRoot(): string {
  return canonicalRepoRoot(getRunContext().repoRoot);
}

/**
 * Did a previous run really clone the repository?
 *
 * **就地模式沒有 clone**：工作區就是使用者的業務倉庫，
 * 「準備好了」的判準是那個倉庫確實是 git 倉庫。
 */
function repoIsCloned(normalizedTaskName: string): boolean {
  // 就地模式沒有 clone：工作區就是使用者的業務倉庫，
  // 「準備好了」的判準是那個倉庫確實是 git 倉庫。
  return fs.existsSync(path.join(repoPathOf(normalizedTaskName), '.git'));
}

/**
 * 清掉舊工作區；刪不掉時不得讓整輪 run 死在這裡。
 *
 * `cleanupTaskWorkspace()` 在刪除目標越界時會拋錯——那是資料安全的硬保護，
 * 不能拿掉。但那個錯誤跟使用者的答案無關，它只是「這個目錄刪不掉」，
 * 讓它從節點裡逃出去只會讓這輪 run 以為使用者放棄了。
 */
function cleanupWorkspace(normalizedTaskName: string): void {
  try {
    cleanupTaskWorkspace(normalizedTaskName);
  } catch (err) {
    console.warn('Failed to clean up the task workspace:', err);
  }
}

/**
 * 清掉「clone 了一半的倉庫」那個空殼。
 *
 * **就地模式那個目錄本來就不存在**（插件在就地模式不建 `repo/`），
 * 刪它只是為了清掉舊版本可能留下的殼；刪不掉也不該讓這輪 run 死在這裡——
 * 那個目錄裡沒有使用者的任何東西。
 */
function removeRepoShell(normalizedTaskName: string): void {
  try {
    fs.rmSync(getRepoDir(normalizedTaskName), { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to remove the empty repo shell:', err);
  }
}

/** Are these the errors a retry can fix? */
function isRetryable(result: StartTaskResult): boolean {
  return result.errorCode === 'git_error' || result.errorCode === 'network_error';
}
