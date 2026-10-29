/**
 * Vocabulary of the SDD workflow state (workflow-state 1.1.0).
 *
 * These declarations are the contract the LangGraph annotation (Task 3) is
 * checked against, so field names and types must not drift. The zod schema in
 * `schema.ts` is bound to them at compile time.
 */

/** Stage the orchestrator currently sits in. */
export type Stage =
  | 'bootstrap'
  | 'prd'
  | 'spec'
  | 'e2ePlan'
  | 'taskSplit'
  | 'tdd'
  | 'verification'
  | 'completed';

/** Sub-stage inside the TDD loop. */
export type TddSubStage =
  | 'pending'
  | 'developer_done'
  | 'spec_review_done'
  | 'quality_review_done'
  | 'completed';

/**
 * Complexity of a task AS STORED in the state: only 'S' and 'M'.
 *
 * An 'L' task is rejected before it ever reaches the state, so the state
 * never has to represent one.
 */
export type Complexity = 'S' | 'M';

/**
 * Complexity as it may appear in `tasks.md`.
 *
 * The parser keeps the wider type on purpose: it has to be able to DETECT an
 * 'L' and report it, so that the task-split gate can reject it. Narrowing it
 * here would make that gate blind.
 */
export type ParsedComplexity = 'S' | 'M' | 'L';

/** A single unit of work produced by the task-split stage. */
export interface Task {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  acRefs: string[];
  complexity: Complexity;
  priority: 'high' | 'medium' | 'low';
}

/** Outcome of a spec review or a quality review. */
export interface ReviewResult {
  role: 'spec' | 'quality';
  verdict: 'pass' | 'fail';
  issues: Array<{
    file: string;
    line?: number;
    message: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
  }>;
}

/** Outcome of one verification gate (lint / test / e2e). */
export interface VerificationCheck {
  name: 'lint:ts' | 'lint' | 'test' | 'e2e';
  status: 'pending' | 'passed' | 'failed' | 'fixed';
  retries: number;
  lastRunAt?: string;
  error?: string;
}

/**
 * One clarification question raised while writing the spec.
 *
 * It is not part of `SddState`: the spec stage keeps its questions in the
 * generated `spec.md`, and the graph only reads them at the stage exit.
 */
export interface SpecQuestion {
  id: string;
  question: string;
  round: 1 | 2 | 3;
  status: 'pending' | 'answered' | 'tbc';
}

/** An open question that was deferred instead of being answered. */
export interface TBCItem {
  id: string;
  description: string;
  blocking: boolean;
  resolved: boolean;
  resolution?: string;
  createdAt: string;
}

/** Something that stops the graph from advancing. */
export interface Blocker {
  id: string;
  taskId: string;
  reason: string;
  createdAt: string;
  /**
   * Is the blocker resolved?
   *
   * A resolved blocker is not a blocker any more: the state drops it, so
   * that a task that runs again does not carry the blocker of its earlier
   * failure.
   */
  resolved?: boolean;
}

/** One produced file tracked by the graph. */
export interface ArtifactEntry {
  path: string;
  hash: string;
  updatedAt: string;
}

/** Produced files, keyed by artifact id. */
export type ArtifactIndex = Record<string, ArtifactEntry>;

/** Human approvals collected per stage (value = approver / timestamp). */
export type Approvals = Partial<Record<'prd' | 'spec' | 'e2ePlan' | 'taskSplit', string>>;

/** The whole workflow state. */
export interface SddState {
  version: '1.1.0';
  requirementName: string;
  repoUrl: string;
  repoPath: string;
  branch: string;
  runId: string;
  bootstrapped: boolean;
  currentStage: Stage;
  artifacts: ArtifactIndex;
  tbcItems: TBCItem[];
  tasks: Task[];
  currentTaskIndex: number;
  tddSubStage: TddSubStage;
  lastReview: ReviewResult | null;
  tddAttempts: number;
  verification: { checks: VerificationCheck[] };
  blockers: Blocker[];
  approvals: Approvals;
  createdAt: string;
  updatedAt: string;
}
