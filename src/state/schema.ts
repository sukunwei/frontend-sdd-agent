import { z } from 'zod';
import type {
  Approvals,
  ArtifactEntry,
  ArtifactIndex,
  Blocker,
  Complexity,
  ReviewResult,
  SddState,
  Stage,
  Task,
  TBCItem,
  TddSubStage,
  VerificationCheck,
} from './types.js';

/**
 * Zod schema of `workflow-state.json` (format 1.1.0).
 *
 * Two rules shape this schema:
 *
 * 1. **Enumerations are strict.** A stage, a sub-stage, a complexity or a
 *    verification status that the graph does not know is a bug, so it is
 *    rejected instead of being silently coerced.
 * 2. **Everything else is lenient.** Every field has a default, so a mirror
 *    that was written partially (or hand-trimmed) still parses instead of
 *    poisoning the reader with an exception. The version literal still
 *    rejects any document that claims a different format.
 *
 * The `L` complexity is legal: an `L` task is a single behaviour that spans
 * several files. The task-split gate is where an `L` that does not look
 * like a single behaviour is rejected.
 */

export const STAGES = [
  'bootstrap',
  'prd',
  'spec',
  'e2ePlan',
  'taskSplit',
  'tdd',
  'verification',
  'completed',
] as const;

export const TDD_SUB_STAGES = ['pending', 'developer_done', 'review_done', 'completed'] as const;

export const VERIFICATION_CHECK_NAMES = ['lint:ts', 'lint', 'test', 'e2e'] as const;

export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed', 'fixed'] as const;

export const PRIORITIES = ['high', 'medium', 'low'] as const;

export const REVIEW_ROLES = ['spec', 'quality'] as const;

export const REVIEW_VERDICTS = ['pass', 'fail'] as const;

/**
 * The severities a review issue may have.
 *
 * `high` is here because the quality reviewer counts the high issues
 * (`FAIL` at two of them, `PASS` below two): a severity the schema does not
 * know cannot be reported, and the thresholds would count nothing.
 */
export const ISSUE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export const StageSchema: z.ZodType<Stage> = z.enum(STAGES);

export const TddSubStageSchema: z.ZodType<TddSubStage> = z.enum(TDD_SUB_STAGES);

export const ComplexitySchema: z.ZodType<Complexity> = z.enum(['S', 'M', 'L']);

export const TaskSchema: z.ZodType<Task> = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()),
  acRefs: z.array(z.string()),
  complexity: ComplexitySchema,
  priority: z.enum(PRIORITIES),
});

export const ReviewIssueSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  severity: z.enum(ISSUE_SEVERITIES),
});

export const ReviewResultSchema: z.ZodType<ReviewResult> = z.object({
  role: z.enum(REVIEW_ROLES),
  verdict: z.enum(REVIEW_VERDICTS),
  issues: z.array(ReviewIssueSchema),
});

export const VerificationCheckSchema: z.ZodType<VerificationCheck> = z.object({
  name: z.enum(VERIFICATION_CHECK_NAMES),
  status: z.enum(VERIFICATION_STATUSES),
  retries: z.number(),
  lastRunAt: z.string().optional(),
  error: z.string().optional(),
});

export const VerificationStateSchema = z.object({
  checks: z.array(VerificationCheckSchema).default([]),
});

export const TBCItemSchema: z.ZodType<TBCItem> = z.object({
  id: z.string(),
  description: z.string(),
  blocking: z.boolean(),
  resolved: z.boolean(),
  resolution: z.string().optional(),
  createdAt: z.string(),
});

export const BlockerSchema: z.ZodType<Blocker> = z.object({
  id: z.string(),
  taskId: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  resolved: z.boolean().optional(),
});

export const ArtifactEntrySchema: z.ZodType<ArtifactEntry> = z.object({
  path: z.string(),
  hash: z.string(),
  updatedAt: z.string(),
});

export const ArtifactIndexSchema: z.ZodType<ArtifactIndex> = z.record(
  z.string(),
  ArtifactEntrySchema
);

export const ApprovalsSchema: z.ZodType<Approvals> = z.object({
  prd: z.string().optional(),
  spec: z.string().optional(),
  e2ePlan: z.string().optional(),
  taskSplit: z.string().optional(),
});

/** The mirror document itself. */
export const WorkflowStateSchema = z.object({
  version: z.literal('1.1.0').default('1.1.0'),
  requirementName: z.string().default(''),
  repoUrl: z.string().default(''),
  repoPath: z.string().default(''),
  branch: z.string().default(''),
  runId: z.string().default(''),
  bootstrapped: z.boolean().default(false),
  currentStage: StageSchema.default('bootstrap'),
  artifacts: ArtifactIndexSchema.default({}),
  tbcItems: z.array(TBCItemSchema).default([]),
  tasks: z.array(TaskSchema).default([]),
  currentTaskIndex: z.number().default(0),
  tddSubStage: TddSubStageSchema.default('pending'),
  lastReviews: z.array(ReviewResultSchema).default([]),
  tddAttempts: z.number().default(0),
  verification: VerificationStateSchema.default({ checks: [] }),
  blockers: z.array(BlockerSchema).default([]),
  approvals: ApprovalsSchema.default({}),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

/** The document as it comes out of the schema. */
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

type Assert<T extends true> = T;

/**
 * Compile-time proof that the zod schema and the hand-written `SddState`
 * describe the same document. If either side drifts, this alias fails to
 * compile.
 */
export type SchemaMatchesState = Assert<
  [WorkflowState] extends [SddState]
    ? [SddState] extends [WorkflowState]
      ? true
      : false
    : false
>;
