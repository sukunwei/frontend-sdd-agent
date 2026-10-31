/**
 * Error types for sdd-graph operations.
 */
export type ErrorCode =
  | 'validation_error'
  | 'lock_conflict'
  | 'workspace_error'
  | 'git_error'
  | 'network_error'
  | 'permission_error'
  | 'infra_error'
  | 'cleanup_failed'
  /** 就地模式：工作區有已跟蹤文件的改動，必須由使用者決定怎麼辦。 */
  | 'dirty_worktree'
  /**
   * 這個 task 已經跑過了（就地模式：倉庫裡已經有它的運行時狀態）。
   *
   * **不是「再試一次就會好」的錯**：重跑不會讓既有的運行時狀態消失，
   * 使用者得自己決定是繼續（resume）還是重來（reset）。
   */
  | 'already_exists';

/**
 * Error categories for recovery strategy selection.
 */
export type ErrorCategory = 'auto_fixable' | 'needs_human' | 'infra_error';

/**
 * 使用者喊停了這輪運行。
 *
 * **這不是失敗，是使用者自己的決定**：所以它有自己的 `code`（`'aborted'`），
 * CLI 靠它認出「使用者中止」而不是「插件壞了」——退出碼與訊息都不同
 * （CLI 那邊的映射由後續任務接上）。
 *
 * **checkpoint 留著**：使用者還可以 `resume` 這一輪，
 * 中止的是這一輪，不是整個 task。
 */
export class SddAbortError extends Error {
  readonly code = 'aborted';

  constructor(message: string) {
    super(message);
    this.name = 'SddAbortError';
  }
}

/**
 * Structured error with recovery hints.
 */
export interface TaskInitError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  originalError?: string;
  recoveryHint: string;
  canRetry: boolean;
  canForceUnlock: boolean;
}

/**
 * Classify error code into category for recovery strategy.
 */
export function classifyError(errorCode: ErrorCode): ErrorCategory {
  switch (errorCode) {
    case 'validation_error':
      return 'needs_human';
    case 'lock_conflict':
      return 'needs_human';
    case 'network_error':
      return 'auto_fixable';
    case 'git_error':
      return 'auto_fixable';
    case 'workspace_error':
      return 'auto_fixable';
    case 'permission_error':
      return 'needs_human';
    case 'infra_error':
      return 'infra_error';
    case 'cleanup_failed':
      return 'infra_error';
    // 髒工作區不是「再試一次就會好」的錯：重試只是把同一份未提交的改動
    // 再帶走一次，必須由使用者決定（提交、暫存，或留在當前分支上工作）。
    case 'dirty_worktree':
      return 'needs_human';
    // 「這個 task 已經跑過了」同樣不是重試能解決的：重跑不會讓既有的
    // 運行時狀態消失，使用者得自己選 resume 或 reset。
    case 'already_exists':
      return 'needs_human';
    default:
      return 'needs_human';
  }
}

/**
 * Get recovery hint for an error.
 */
export function getRecoveryHint(error: TaskInitError): string {
  switch (error.category) {
    case 'auto_fixable':
      return `You can retry this operation. ${error.canRetry ? 'A retry is recommended.' : 'Manual retry required.'}`;
    case 'needs_human':
      return error.recoveryHint;
    case 'infra_error':
      return `Infrastructure error detected. Try again later or use --force-unlock if lock is stuck.`;
  }
}

/**
 * Format error for display to user.
 */
export function formatError(error: TaskInitError): string {
  return `## Error

**Code**: ${error.code}
**Category**: ${error.category}

${error.message}

${error.originalError ? `**Details**: ${error.originalError}` : ''}

**Recovery**: ${getRecoveryHint(error)}`;
}

/**
 * Create error from operation result.
 */
export function createError(
  code: ErrorCode,
  message: string,
  originalError?: string
): TaskInitError {
  const category = classifyError(code);
  const canRetry =
    category === 'auto_fixable' || code === 'git_error' || code === 'network_error';
  const canForceUnlock = code === 'lock_conflict' || code === 'infra_error';

  const recoveryHints: Record<ErrorCode, string> = {
    validation_error: 'Check the task name format. Use only alphanumeric characters and hyphens.',
    lock_conflict: 'Use /sdd-graph:stop to release the current lock, or wait for the running task to complete.',
    workspace_error: 'Delete the existing workspace directory and retry.',
    git_error: 'Check network connectivity and repository URL.',
    network_error: 'Check your internet connection and try again.',
    permission_error: 'Check git credentials and repository access permissions.',
    infra_error: 'Report this issue. Try --force-unlock as workaround.',
    cleanup_failed: 'Manually remove the task directory and use --force-unlock.',
    dirty_worktree:
      '工作區有未提交的改動：先提交或暫存再重新啟動，或確認留在當前分支上工作。',
    already_exists:
      '這個 task 已經跑過了：請用 resume 繼續那一輪，或先 reset 之後再重新啟動。',
  };

  return {
    code,
    category,
    message,
    originalError,
    recoveryHint: recoveryHints[code] || 'Unknown error type.',
    canRetry,
    canForceUnlock,
  };
}

/**
 * Error codes mapped to user-friendly messages.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  validation_error: 'Invalid task name or parameters',
  lock_conflict: 'Another task is currently running',
  workspace_error: 'Failed to create or access workspace',
  git_error: 'Git operation failed',
  network_error: 'Network connection failed',
  permission_error: 'Permission denied',
  infra_error: 'Infrastructure error',
  cleanup_failed: 'Cleanup operation failed',
  dirty_worktree: '工作區有未提交的改動',
  already_exists: '這個 task 已經跑過了',
};
