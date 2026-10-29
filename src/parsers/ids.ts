/**
 * The public entry point of the parser package.
 *
 * `src/parsers/ids.js` is the single import surface: it re-exports the ID
 * formats and helpers (`id-patterns.ts`), the three document parsers
 * (`spec-md.ts`, `tasks-md.ts`, `e2e-csv.ts`) and the two shapes the parsers
 * produce.
 *
 * The barrel re-exports and nothing else - it holds no binding of its own
 * that the re-exported modules could read while they are still initialising.
 * `id-patterns.ts` is the leaf every parser depends on, so the package has
 * no module cycle.
 */
import type { ParsedComplexity } from '../state/types.js';

export * from './id-patterns.js';

export { parseAcIds, parseQuestions, parseTbcItems } from './spec-md.js';
export { parseComplexity, parseTaskIds, parseTasks } from './tasks-md.js';
export { parseE2eIds, parseE2eRows } from './e2e-csv.js';

/**
 * A task as it appears in `tasks.md`.
 *
 * `complexity` keeps the wide type on purpose: the parser has to be able to
 * SEE an `L` so the task-split gate can reject it. The state stores the narrow
 * `Task` (Task 2), where `L` does not exist.
 */
export interface ParsedTask {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  acRefs: string[];
  complexity: ParsedComplexity;
  priority: 'high' | 'medium' | 'low';
}

/**
 * One row of `e2e-plan.csv`.
 *
 * `acRefs` is the acceptance criteria the scenario covers - it is what makes
 * the traceability matrix (task split) possible without re-parsing the
 * scenario text.
 */
export interface E2eRow {
  testId: string;
  feature: string;
  scenario: string;
  steps: string[];
  expectedResult: string;
  priority: 'high' | 'medium' | 'low';
  acRefs: string[];
}
