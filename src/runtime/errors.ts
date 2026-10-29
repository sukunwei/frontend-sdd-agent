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
  | 'cleanup_failed';

/**
 * Error categories for recovery strategy selection.
 */
export type ErrorCategory = 'auto_fixable' | 'needs_human' | 'infra_error';

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
};
