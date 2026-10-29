/**
 * The ID formats of the SDD documents, and the helpers that work on them.
 *
 * This module is a **leaf**: it imports nothing from its siblings, so the
 * document parsers (`spec-md.ts`, `tasks-md.ts`, `e2e-csv.ts`) and the barrel
 * (`ids.ts`) can all depend on it without forming a module cycle.
 *
 * Every ID that enters the workflow comes from one of the SDD documents, so
 * the formats are pinned down here:
 *
 * | Kind     | Format        | Lives in       |
 * |----------|---------------|----------------|
 * | AC       | `AC-\d{3}`    | `spec.md`      |
 * | E2E      | `E2E-\d{3}`   | `e2e-plan.csv` |
 * | TASK     | `TASK-<slug>` | `tasks.md`     |
 * | TBC      | `TBC-\d{3}`   | `spec.md`      |
 * | Q        | `Q-\d{3}`     | `spec.md`      |
 *
 * The state schema (Task 2) deliberately accepts any string as an id, so the
 * parsers are the only place where a malformed id can still be caught. That
 * is why the patterns below are used to *validate*, not merely to search:
 * `AC-0012` is not an `AC-001`.
 */

/** An acceptance criterion declared in `spec.md`. */
export const AC_ID_PATTERN = /^AC-\d{3}$/;

/** An e2e test case declared in `e2e-plan.csv`. */
export const E2E_ID_PATTERN = /^E2E-\d{3}$/;

/** A task declared in `tasks.md`; the slug is derived from the task title. */
export const TASK_ID_PATTERN = /^TASK-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The pre-slug task id format, still readable so old documents do not break. */
export const LEGACY_TASK_ID_PATTERN = /^task-\d+$/;

/** A to-be-confirmed item declared in `spec.md`. */
export const TBC_ID_PATTERN = /^TBC-\d{3}$/;

/** A clarification question declared in `spec.md`. */
export const QUESTION_ID_PATTERN = /^Q-\d{3}$/;

/**
 * An acronym written in capitals, e.g. the `QR` of `QR code`.
 *
 * Only an acronym may be joined with the word it modifies, and only when the
 * pair is a known compound (see {@link KNOWN_COMPOUND_TERMS}).
 */
const ACRONYM_PATTERN = /^[A-Z]{2,}$/;

/**
 * Terms that are a single word although the title writes them as two.
 *
 * `QR code` is one thing, so its slug is `qrcode` and not `qr-code`. Only the
 * pairs listed here are joined - every other acronym keeps its own word
 * (`Add UI tests` becomes `add-ui-tests`), so the rule stays predictable and
 * never produces ids nobody expects. The list has to be maintained when a new
 * compound term shows up.
 */
const KNOWN_COMPOUND_TERMS: ReadonlySet<string> = new Set(['qrcode']);

/** Longest slug a task id may carry. */
export const MAX_SLUG_LENGTH = 48;

export function isAcId(value: string): boolean {
  return AC_ID_PATTERN.test(value);
}

export function isE2eId(value: string): boolean {
  return E2E_ID_PATTERN.test(value);
}

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export function isLegacyTaskId(value: string): boolean {
  return LEGACY_TASK_ID_PATTERN.test(value);
}

export function isTbcId(value: string): boolean {
  return TBC_ID_PATTERN.test(value);
}

export function isQuestionId(value: string): boolean {
  return QUESTION_ID_PATTERN.test(value);
}

/**
 * Derive the stable slug of a task id from its title.
 *
 * The title is split on every non-alphanumeric character and every word is
 * lower-cased. An acronym written in capitals is joined with the word it
 * modifies when the two form a known compound: `Setup QR code page route`
 * becomes `setup-qrcode-page-route`, not `setup-qr-code-page-route`. Every
 * other acronym keeps its own word: `Add UI tests` becomes `add-ui-tests`.
 *
 * The slug is capped at `MAX_SLUG_LENGTH` characters and never ends with a
 * dangling `-`, so the same title always yields the same slug.
 *
 * Two different titles can still collide (`Setup QR page` and `Setup-QR-page`);
 * that is the caller's business - the task-split gate checks for duplicate
 * ids.
 */
export function slugifyTaskId(title: string): string {
  const words = title.split(/[^a-zA-Z0-9]+/).filter(word => word.length > 0);

  const merged: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const next = words[index + 1];
    const compound = next === undefined ? '' : `${word.toLowerCase()}${next.toLowerCase()}`;
    if (next !== undefined && ACRONYM_PATTERN.test(word) && KNOWN_COMPOUND_TERMS.has(compound)) {
      merged.push(compound);
      index += 1;
      continue;
    }
    merged.push(word.toLowerCase());
  }

  return merged.join('-').slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}

/**
 * Extract every acceptance criterion id mentioned in a piece of text.
 *
 * A candidate that looks like an AC id but is not well formed (`AC-12`) is an
 * error rather than something to skip silently: the document would otherwise
 * lose a traceability link without anybody noticing.
 */
export function parseAcRefsInText(text: string): string[] {
  const refs: string[] = [];
  for (const candidate of text.match(/\bAC-[0-9]+\b/g) ?? []) {
    if (!isAcId(candidate)) {
      throw new Error(`invalid acceptance criteria id "${candidate}" (expected AC-\\d{3})`);
    }
    if (!refs.includes(candidate)) refs.push(candidate);
  }
  return refs;
}
