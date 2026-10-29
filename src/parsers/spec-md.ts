/**
 * Parser for `spec.md`.
 *
 * The spec document carries three kinds of ids:
 *
 * - acceptance criteria, declared as `### AC-001: <description>` headings
 * - clarification questions, declared as `- [Q-001] <question>` list items
 * - to-be-confirmed items, declared as `- [TBC-001] <item>` list items
 *
 * Everything is read as plain text: the parser never touches the filesystem,
 * so it can be pointed at a document that was just written.
 */
import type { SpecQuestion, TBCItem } from '../state/types.js';
import { isAcId, isQuestionId, isTbcId } from './id-patterns.js';

/**
 * `### AC-001: <description>` - the only place an AC id is declared.
 *
 * The number is captured loosely and checked afterwards, so a malformed id
 * (`AC-0012`) is recognised as an attempt and skipped instead of being
 * mistaken for a valid one.
 */
const AC_HEADING_PATTERN = /^###\s+(AC-\d+):/;

/** `- [TBC-001] <item>` - a deferred question. */
const TBC_ITEM_PATTERN = /^\s*[-*]\s+\[(TBC-\d+)\]\s*(.*)$/;

/** `- [Q-001] <question>` - a clarification question. */
const QUESTION_ITEM_PATTERN = /^\s*[-*]\s+\[(Q-\d+)\]\s*(.*)$/;

/** `### Round 2` - the clarification round a question belongs to. */
const ROUND_HEADING_PATTERN = /^#{1,6}\s*Round\s*([123])\b/i;

/** `(blocking)` / `(non-blocking)` - whether a TBC blocks the workflow. */
const BLOCKING_MARKER_PATTERN = /^\((blocking|non-blocking)\)\s*/i;

/** `(resolved: <text>)` - a TBC that has been answered already. */
const RESOLVED_MARKER_PATTERN = /^\(resolved:\s*(.*?)\)\s*/i;

/** `(answered)` / `(tbc)` / `(pending)` - the status of a question. */
const STATUS_MARKER_PATTERN = /^\((answered|tbc|pending)\)\s*/i;

/**
 * Read the acceptance criteria ids out of a spec document.
 *
 * Only the `### AC-\d{3}:` headings declare a criterion; a mention of
 * `AC-002` in the prose is a reference, not a declaration.
 */
export function parseAcIds(specMd: string): string[] {
  const ids: string[] = [];
  for (const line of specMd.split(/\r?\n/)) {
    const match = AC_HEADING_PATTERN.exec(line);
    if (!match) continue;
    const id = match[1];
    if (!isAcId(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Options for {@link parseTbcItems}. */
export interface ParseTbcOptions {
  /**
   * Timestamp stamped on every item. The parser has no clock of its own, so
   * the caller decides when the item was created.
   */
  createdAt?: string;
}

/**
 * Read the to-be-confirmed items out of a spec document.
 *
 * A TBC is blocking when it is marked `(blocking)`; the marker may also carry
 * the resolution of an item that was answered later on.
 */
export function parseTbcItems(specMd: string, options: ParseTbcOptions = {}): TBCItem[] {
  const items: TBCItem[] = [];
  for (const line of specMd.split(/\r?\n/)) {
    const match = TBC_ITEM_PATTERN.exec(line);
    if (!match) continue;
    const id = match[1];
    if (!isTbcId(id)) continue;

    let rest = match[2].trim();
    let blocking = false;
    let resolved = false;
    let resolution: string | undefined;

    const blockingMarker = BLOCKING_MARKER_PATTERN.exec(rest);
    if (blockingMarker) {
      blocking = blockingMarker[1].toLowerCase() === 'blocking';
      rest = rest.slice(blockingMarker[0].length).trim();
    }

    const resolvedMarker = RESOLVED_MARKER_PATTERN.exec(rest);
    if (resolvedMarker) {
      resolved = true;
      resolution = resolvedMarker[1].trim();
      rest = rest.slice(resolvedMarker[0].length).trim();
    }

    const item: TBCItem = {
      id,
      description: rest,
      blocking,
      resolved,
      createdAt: options.createdAt ?? '',
    };
    if (resolution !== undefined) item.resolution = resolution;
    items.push(item);
  }
  return items;
}

/**
 * Read the clarification questions out of a spec document.
 *
 * The round of a question is the `### Round N` heading it sits under (1 when
 * it sits under none); its status is the `(answered)` / `(tbc)` /
 * `(pending)` marker in front of it, defaulting to `pending`.
 */
export function parseQuestions(specMd: string): SpecQuestion[] {
  const questions: SpecQuestion[] = [];
  let round: SpecQuestion['round'] = 1;

  for (const line of specMd.split(/\r?\n/)) {
    const roundMatch = ROUND_HEADING_PATTERN.exec(line);
    if (roundMatch) {
      round = Number(roundMatch[1]) as SpecQuestion['round'];
      continue;
    }

    const match = QUESTION_ITEM_PATTERN.exec(line);
    if (!match) continue;
    const id = match[1];
    if (!isQuestionId(id)) continue;

    let text = match[2].trim();
    let status: SpecQuestion['status'] = 'pending';
    const statusMarker = STATUS_MARKER_PATTERN.exec(text);
    if (statusMarker) {
      status = statusMarker[1].toLowerCase() as SpecQuestion['status'];
      text = text.slice(statusMarker[0].length).trim();
    }

    questions.push({ id, question: text, round, status });
  }
  return questions;
}
