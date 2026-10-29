/**
 * Parser for `e2e-plan.csv`.
 *
 * The file is a plain CSV with a fixed header:
 *
 * ```
 * test_id,feature,scenario,steps,expected_result,priority
 * E2E-001,Text Input,Empty input shows placeholder (AC-001),"Open /qrcode-app;Observe the QR area",Placeholder message is visible,high
 * ```
 *
 * The steps of one scenario are separated by `;` (a comma would collide with
 * the CSV separator) and the acceptance criteria the scenario covers are
 * written into the scenario as `(AC-001)`.
 */
import { isE2eId, parseAcRefsInText } from './id-patterns.js';
import type { E2eRow } from './ids.js';

/** The columns the file has to provide. */
const EXPECTED_COLUMNS = [
  'test_id',
  'feature',
  'scenario',
  'steps',
  'expected_result',
  'priority',
] as const;

/** Separator between the steps of one scenario. */
const STEP_SEPARATOR = ';';

/**
 * Split one CSV line into its cells.
 *
 * Quoted cells may contain commas and `""` is an escaped quote.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char !== '"') {
        current += char;
        continue;
      }
      if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/** Split the steps cell into its single steps. */
function readSteps(cell: string): string[] {
  return cell
    .split(STEP_SEPARATOR)
    .map(step => step.trim())
    .filter(step => step !== '');
}

/** The meaningful lines of the file: no blanks, no comments. */
function readLines(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
}

/**
 * Read every e2e test case of the plan.
 *
 * A missing column, a malformed test id, a duplicated test id or an unknown
 * priority is an error: the plan would otherwise lose a test without anybody
 * noticing.
 */
export function parseE2eRows(csv: string): E2eRow[] {
  const lines = readLines(csv);
  if (lines.length === 0) {
    throw new Error('e2e-plan.csv: file is empty');
  }

  const headers = splitCsvLine(lines[0]).map(header => header.toLowerCase());
  const missing = EXPECTED_COLUMNS.filter(column => !headers.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `e2e-plan.csv: missing column(s) ${missing.join(', ')} (expected header: ${EXPECTED_COLUMNS.join(',')})`
    );
  }

  const cellOf = (cells: string[], column: string): string =>
    cells[headers.indexOf(column)] ?? '';

  const rows: E2eRow[] = [];
  const seen = new Set<string>();

  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    const testId = cellOf(cells, 'test_id');

    if (!isE2eId(testId)) {
      throw new Error(
        `e2e-plan.csv line ${index + 1}: invalid test_id "${testId}" (expected E2E-\\d{3})`
      );
    }
    if (seen.has(testId)) {
      throw new Error(`e2e-plan.csv line ${index + 1}: duplicated test_id "${testId}"`);
    }
    seen.add(testId);

    const priority = cellOf(cells, 'priority').toLowerCase();
    if (priority !== 'high' && priority !== 'medium' && priority !== 'low') {
      throw new Error(
        `e2e-plan.csv line ${index + 1}: invalid priority "${priority}" (expected high, medium or low)`
      );
    }

    const scenario = cellOf(cells, 'scenario');
    rows.push({
      testId,
      feature: cellOf(cells, 'feature'),
      scenario,
      steps: readSteps(cellOf(cells, 'steps')),
      expectedResult: cellOf(cells, 'expected_result'),
      priority,
      acRefs: parseAcRefsInText(scenario),
    });
  }

  return rows;
}

/** The test ids of the plan, in document order. */
export function parseE2eIds(csv: string): string[] {
  return parseE2eRows(csv).map(row => row.testId);
}
