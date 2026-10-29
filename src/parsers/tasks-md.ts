/**
 * Parser for `tasks.md`.
 *
 * The document has two parts:
 *
 * 1. a table of tasks - `Task ID | Title | Complexity | Priority | AC Refs`
 * 2. one detail block per task, headed by the task id
 *
 * ```markdown
 * | Task ID | Title | Complexity | Priority | AC Refs |
 * |---------|-------|------------|----------|---------|
 * | TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-001 |
 *
 * ### TASK-setup-qrcode-page-route: Setup QR code page route
 *
 * **Description**: 建立 `/qrcode-app` 頁面路由
 *
 * **Acceptance Criteria**:
 * - 路由 `/qrcode-app` 存在且可渲染
 * - 頁面出現 "QR Code Generator" 標題
 *
 * **AC Refs**: AC-001
 * ```
 *
 * The parser is strict about the parts that the rest of the workflow relies
 * on: a task id has to be `TASK-<slug>` (the old `task-<n>` is accepted and
 * upgraded), a complexity has to be `S`, `M` or `L`, and a priority has to be
 * `high`, `medium` or `low`.
 */
import type { ParsedComplexity } from '../state/types.js';
import {
  isLegacyTaskId,
  isTaskId,
  parseAcRefsInText,
  slugifyTaskId,
} from './id-patterns.js';
import type { ParsedTask } from './ids.js';

/** `| a | b |` - one markdown table row. */
const TABLE_ROW_PATTERN = /^\|/;

/** `|---|---|` - the separator under a table header. */
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{1,}:?$/;

/** `### TASK-xxx: Title` - the heading of a task detail block. */
const DETAIL_HEADING_PATTERN = /^(#{2,6})\s+(.+?)\s*$/;

/**
 * The task id at the beginning of a detail heading.
 *
 * The id is captured loosely - a heading that starts like a task id but is
 * malformed (`### TASK-Setup_Page`) still counts as a task detail block, so
 * it can be reported instead of being dropped.
 */
const DETAIL_ID_PATTERN = /^(TASK-[A-Za-z0-9_-]*|task-\d+)/;

/** `**Description**: ...` */
const DESCRIPTION_MARKER_PATTERN = /^\*\*Description\*\*:\s*(.*)$/;

/** `**Acceptance Criteria**:` - the criteria may start on the same line. */
const ACCEPTANCE_MARKER_PATTERN = /^\*\*Acceptance Criteria\*\*:\s*(.*)$/;

/** `**AC Refs**: AC-001, AC-002` */
const AC_REFS_MARKER_PATTERN = /^\*\*AC Refs\*\*:\s*(.*)$/;

/** Any other `**Marker**: value` line, used to stop a description. */
const ANY_MARKER_PATTERN = /^\*\*[^*]+\*\*\s*:/;

/** `- a criterion` */
const BULLET_PATTERN = /^\s*[-*]\s+(.*)$/;

interface Table {
  headers: string[];
  rows: string[][];
}

interface DetailBlock {
  id: string;
  lines: string[];
}

/** Split a markdown table row into its cells. */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map(cell => cell.trim());
}

/** Is this row the `|---|---|` separator under a table header? */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(cell => TABLE_SEPARATOR_CELL_PATTERN.test(cell));
}

/**
 * Find the first table whose header matches the predicate.
 *
 * @param lines - the document, split into lines
 * @param matches - what the header has to look like
 */
function findTable(lines: string[], matches: (headers: string[]) => boolean): Table | undefined {
  let index = 0;
  while (index < lines.length) {
    if (!TABLE_ROW_PATTERN.test(lines[index].trim())) {
      index += 1;
      continue;
    }

    const block: string[] = [];
    while (index < lines.length && TABLE_ROW_PATTERN.test(lines[index].trim())) {
      block.push(lines[index]);
      index += 1;
    }
    if (block.length < 2) continue;

    const headers = splitTableRow(block[0]).map(header => header.toLowerCase());
    if (!matches(headers)) continue;
    if (!isSeparatorRow(splitTableRow(block[1]))) continue;

    const rows = block
      .slice(2)
      .map(splitTableRow)
      .filter(cells => cells.some(cell => cell !== ''));
    return { headers, rows };
  }
  return undefined;
}

/** Collect the detail blocks, keyed by the task id in their heading. */
function findDetailBlocks(lines: string[]): Map<string, DetailBlock> {
  const blocks = new Map<string, DetailBlock>();

  for (let index = 0; index < lines.length; index += 1) {
    const heading = DETAIL_HEADING_PATTERN.exec(lines[index]);
    if (!heading) continue;

    const level = heading[1].length;
    const text = heading[2];
    const idMatch = DETAIL_ID_PATTERN.exec(text);
    if (!idMatch) continue;
    const id = idMatch[1];

    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextHeading = DETAIL_HEADING_PATTERN.exec(lines[cursor]);
      if (nextHeading && nextHeading[1].length <= level) break;
      body.push(lines[cursor]);
      cursor += 1;
    }

    if (!blocks.has(id)) blocks.set(id, { id, lines: body });
    index = cursor - 1;
  }
  return blocks;
}

/** Read the description, the acceptance criteria and the AC refs of a block. */
function readDetailBlock(lines: string[]): {
  description?: string;
  acceptanceCriteria: string[];
  acRefs: string[];
} {
  let description: string | undefined;
  const acceptanceCriteria: string[] = [];
  const acRefs: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const descriptionMatch = DESCRIPTION_MARKER_PATTERN.exec(line);
    if (descriptionMatch) {
      const parts = [descriptionMatch[1].trim()];
      let cursor = index + 1;
      while (
        cursor < lines.length &&
        lines[cursor].trim() !== '' &&
        !BULLET_PATTERN.test(lines[cursor]) &&
        !ANY_MARKER_PATTERN.test(lines[cursor])
      ) {
        parts.push(lines[cursor].trim());
        cursor += 1;
      }
      const text = parts.filter(part => part !== '').join(' ');
      if (text !== '') description = text;
      index = cursor - 1;
      continue;
    }

    const acceptanceMatch = ACCEPTANCE_MARKER_PATTERN.exec(line);
    if (acceptanceMatch) {
      const inline = acceptanceMatch[1].trim();
      if (inline !== '') acceptanceCriteria.push(inline.replace(/^[-*]\s*/, '').trim());
      let cursor = index + 1;
      // A blank line between the marker and the list is common; the list still
      // belongs to the marker.
      while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
      while (cursor < lines.length) {
        if (lines[cursor].trim() === '') {
          cursor += 1;
          continue;
        }
        const bullet = BULLET_PATTERN.exec(lines[cursor]);
        if (!bullet) break;
        const text = bullet[1].trim();
        if (text !== '') acceptanceCriteria.push(text);
        cursor += 1;
      }
      index = cursor - 1;
      continue;
    }

    const acRefsMatch = AC_REFS_MARKER_PATTERN.exec(line);
    if (acRefsMatch) {
      for (const ref of parseAcRefsInText(acRefsMatch[1])) {
        if (!acRefs.includes(ref)) acRefs.push(ref);
      }
      continue;
    }
  }

  return { description, acceptanceCriteria, acRefs };
}

/** Read the complexity cell; the wide type keeps `L` visible to the gate. */
function readComplexity(cell: string | undefined): ParsedComplexity {
  const value = (cell ?? '').trim().toUpperCase();
  if (value === 'S' || value === 'M' || value === 'L') return value;
  throw new Error(
    `tasks.md: invalid complexity "${(cell ?? '').trim()}" (expected S, M or L)`
  );
}

/** Read the priority cell. */
function readPriority(cell: string | undefined): 'high' | 'medium' | 'low' {
  const value = (cell ?? '').trim().toLowerCase();
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  throw new Error(
    `tasks.md: invalid priority "${(cell ?? '').trim()}" (expected high, medium or low)`
  );
}

/**
 * The id a task row gets.
 *
 * A `TASK-<slug>` id is used as it is; the old `task-<n>` format is upgraded
 * to the slug derived from the title, so a legacy document still produces
 * stable ids. Anything else is rejected - an id that does not follow the
 * format would break the traceability links.
 */
function readTaskId(rawId: string, title: string): string {
  const id = rawId.trim();
  if (isTaskId(id)) return id;
  if (isLegacyTaskId(id)) return `TASK-${slugifyTaskId(title)}`;
  throw new Error(
    `tasks.md: invalid task id "${id}" (expected TASK-<slug>, e.g. TASK-setup-qrcode-page-route)`
  );
}

/**
 * Collect every task id mentioned in the document.
 *
 * Both the current `TASK-<slug>` format and the old `task-<n>` format are
 * returned, so an old document can still be read.
 */
export function parseTaskIds(tasksMd: string): string[] {
  const ids: string[] = [];
  const candidates = tasksMd.match(/\bTASK-[A-Za-z0-9_-]+|\btask-\d+/g) ?? [];
  for (const candidate of candidates) {
    if (!isTaskId(candidate) && !isLegacyTaskId(candidate)) continue;
    if (!ids.includes(candidate)) ids.push(candidate);
  }
  return ids;
}

/**
 * Read the complexity of every task, in document order.
 *
 * The result keeps the wide type: an `L` has to reach the task-split gate
 * instead of being hidden by the parser.
 */
export function parseComplexity(tasksMd: string): ParsedComplexity[] {
  const lines = tasksMd.split(/\r?\n/);
  const table = findTable(lines, headers => headers.includes('task id'));
  if (!table) {
    throw new Error('tasks.md: no task table found (expected a table with a "Task ID" column)');
  }
  const column = table.headers.indexOf('complexity');
  if (column < 0) {
    throw new Error('tasks.md: task table has no "Complexity" column');
  }
  return table.rows.map(row => readComplexity(row[column]));
}

/**
 * Read every task of the document.
 *
 * The table decides which tasks exist and in which order; the detail blocks
 * add the description, the acceptance criteria and the AC references.
 */
export function parseTasks(tasksMd: string): ParsedTask[] {
  const lines = tasksMd.split(/\r?\n/);
  const table = findTable(lines, headers => headers.includes('task id'));
  if (!table) {
    throw new Error('tasks.md: no task table found (expected a table with a "Task ID" column)');
  }

  const columnOf = (name: string): number => table.headers.indexOf(name);
  const idColumn = columnOf('task id');
  const titleColumn = columnOf('title');
  const complexityColumn = columnOf('complexity');
  const priorityColumn = columnOf('priority');
  const acRefsColumn = columnOf('ac refs');

  if (titleColumn < 0) {
    throw new Error('tasks.md: task table has no "Title" column');
  }
  if (complexityColumn < 0) {
    throw new Error('tasks.md: task table has no "Complexity" column');
  }
  if (priorityColumn < 0) {
    throw new Error('tasks.md: task table has no "Priority" column');
  }

  const blocks = findDetailBlocks(lines);
  const rawIds = new Set<string>();
  const tasks: ParsedTask[] = [];

  for (const row of table.rows) {
    const rawId = (row[idColumn] ?? '').trim();
    const title = (row[titleColumn] ?? '').trim();
    if (title === '') {
      throw new Error(`tasks.md: task "${rawId}" has no title`);
    }

    const id = readTaskId(rawId, title);
    rawIds.add(rawId);

    const block = blocks.get(rawId);
    const detail: {
      description?: string;
      acceptanceCriteria: string[];
      acRefs: string[];
    } = block ? readDetailBlock(block.lines) : { acceptanceCriteria: [], acRefs: [] };

    const acRefs: string[] = [];
    if (acRefsColumn >= 0) {
      for (const ref of parseAcRefsInText(row[acRefsColumn] ?? '')) acRefs.push(ref);
    }
    for (const ref of detail.acRefs) {
      if (!acRefs.includes(ref)) acRefs.push(ref);
    }

    const task: ParsedTask = {
      id,
      title,
      acceptanceCriteria: detail.acceptanceCriteria,
      acRefs,
      complexity: readComplexity(row[complexityColumn]),
      priority: readPriority(row[priorityColumn]),
    };
    if (detail.description !== undefined) task.description = detail.description;
    tasks.push(task);
  }

  for (const id of blocks.keys()) {
    if (rawIds.has(id)) continue;
    // A detail block without a task in the table is a broken document: the id
    // may even be malformed (`### TASK-Setup_Page`), and its acceptance
    // criteria would be dropped without anybody noticing.
    throw new Error(`tasks.md: detail block for "${id}" has no matching task in the table`);
  }

  return tasks;
}
