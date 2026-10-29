const MAX_TASKNAME_LENGTH = 64;
const INVALID_CHARS = /[\/\\:*?"<>|]/g;
const WHITESPACE_COLLAPSE = /\s+/g;

/**
 * Normalize a raw task name into a safe directory and branch name.
 *
 * Rules:
 * 1. Collapse internal whitespace, trim leading/trailing whitespace
 * 2. Replace invalid filename chars with `-`
 * 3. Convert to lowercase kebab-case
 * 4. Truncate to MAX_TASKNAME_LENGTH
 * 5. Ensure not empty after normalization (fallback to "task")
 *
 * @param taskNameRaw - Raw task name from user input
 * @returns normalized task name safe for use as directory/branch name
 */
export function normalizeTaskName(taskNameRaw: string): string {
  if (!taskNameRaw || typeof taskNameRaw !== 'string') {
    return 'task';
  }

  // Step 1: Trim and collapse whitespace
  let normalized = taskNameRaw.trim().replace(WHITESPACE_COLLAPSE, '-');

  // Step 2: Replace invalid chars
  normalized = normalized.replace(INVALID_CHARS, '-');

  // Step 3: Convert to lowercase kebab-case (keep only alphanumeric and hyphen)
  normalized = normalized.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Step 4: Collapse multiple dashes
  normalized = normalized.replace(/-+/g, '-');

  // Step 5: Trim leading/trailing dashes
  normalized = normalized.replace(/^-+|-+$/g, '');

  // Step 6: Truncate to max length (but keep complete segments)
  if (normalized.length > MAX_TASKNAME_LENGTH) {
    normalized = normalized.substring(0, MAX_TASKNAME_LENGTH);
    // Trim trailing dash if we cut mid-segment
    normalized = normalized.replace(/-+$/, '');
  }

  // Fallback if empty
  if (!normalized) {
    return 'task';
  }

  return normalized;
}

/**
 * Generate branch name from task name.
 * Format: task/<taskName>
 */
export function generateBranchName(taskNameNormalized: string): string {
  return `task/${taskNameNormalized}`;
}

/**
 * Generate runId in format: run_YYYYMMDD_HHmmss
 */
export function generateRunId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `run_${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Validate task name and return validation result with any warnings.
 */
export function validateTaskName(taskNameRaw: string): {
  valid: boolean;
  normalized: string;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!taskNameRaw || typeof taskNameRaw !== 'string') {
    return { valid: false, normalized: 'task', warnings: ['Task name is required, using fallback "task"'] };
  }

  const normalized = normalizeTaskName(taskNameRaw);

  if (taskNameRaw.trim() !== taskNameRaw) {
    warnings.push('Task name had leading/trailing whitespace - it will be trimmed');
  }

  if (INVALID_CHARS.test(taskNameRaw)) {
    warnings.push('Task name contained invalid characters - they will be replaced with "-"');
  }

  if (taskNameRaw.length > MAX_TASKNAME_LENGTH) {
    warnings.push(`Task name exceeded ${MAX_TASKNAME_LENGTH} characters - it will be truncated`);
  }

  if (normalized !== taskNameRaw.toLowerCase().replace(INVALID_CHARS, '-').trim()) {
    warnings.push('Task name was normalized to lowercase kebab-case');
  }

  return { valid: true, normalized, warnings };
}
