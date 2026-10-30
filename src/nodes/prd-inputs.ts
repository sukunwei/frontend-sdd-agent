import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readSourceFile } from '../runtime/source-files.js';

/**
 * The answers of the `collect_prd` gate.
 *
 * The user gives three things: the **PRD** (a file path or a text), the
 * **design** (a Figma link or a text description) and any **other documents**
 * they want the spec writer to read.
 *
 * **Every shape is read defensively.** The host may send the new shape, the
 * old one (`prdMarkdown` / `figmaUrl`), or a plain string; the graph does
 * not assume a shape it has not agreed on. What it *does* insist on is that
 * there is a PRD: a requirement without one is not a requirement, and the
 * gate says so instead of asking again and again.
 */

/** The PRD: a text, or a file the graph reads. */
export type PrdInput =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string };

/** The design: a Figma link, a description in words, or nothing. */
export type DesignInput =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' };

/** An extra document: a file the graph reads, or a text. */
export type RefInput =
  | { kind: 'file'; path: string }
  | { kind: 'text'; name: string; text: string };

/** Everything the user gave at the `collect_prd` gate. */
export interface PrdInputs {
  /** The requirements. */
  prd: PrdInput;
  /** The design context. */
  figma: DesignInput;
  /** The other documents. */
  docs: RefInput[];
}

/** The file the PRD is written to, inside the requirement directory. */
export const PRD_FILE = 'prd.md';

/** The file a design described in words is written to. */
export const DESIGN_FILE = 'design.md';

/** The directory the other documents are written to. */
export const REFS_DIR = 'refs';

/**
 * Read the answer of the `collect_prd` gate.
 *
 * @param answer - The value the gate was answered with.
 * @returns What the user gave.
 * @throws Error when the answer has no usable PRD. The shape of the gate is
 *   documented in its payload; an answer that does not fit it is a mistake
 *   worth saying out loud rather than asking again silently.
 */
export function readPrdInputs(answer: unknown): PrdInputs {
  // The oldest shape: the whole answer is the markdown.
  if (typeof answer === 'string') {
    const text = answer.trim();
    if (text === '') throw noPrd(answer);
    return { prd: { kind: 'text', text }, figma: { kind: 'none' }, docs: [] };
  }

  if (typeof answer !== 'object' || answer === null) {
    throw noPrd(answer);
  }

  const payload = answer as Record<string, unknown>;
  const prd = readPrdInput(payload);
  if (prd === undefined) throw noPrd(answer);

  return {
    prd,
    figma: readDesignInput(payload),
    docs: readRefInputs(payload),
  };
}

/** The PRD of the answer. */
function readPrdInput(payload: Record<string, unknown>): PrdInput | undefined {
  // `prd` is the current name, `prdMarkdown` the one before it.
  const raw = payload.prd ?? payload.prdMarkdown;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? undefined : { kind: 'text', text };
  }
  if (typeof raw === 'object' && raw !== null) {
    const value = raw as Record<string, unknown>;
    const file = value.path;
    if (typeof file === 'string' && file.trim() !== '') {
      return { kind: 'file', path: file.trim() };
    }
    const text = value.text ?? value.markdown;
    if (typeof text === 'string' && text.trim() !== '') {
      return { kind: 'text', text: text.trim() };
    }
  }
  return undefined;
}

/**
 * The design of the answer.
 *
 * A plain string is a Figma link when it looks like one and a description
 * in words otherwise - the user answered "the design is in this file" and
 * "there is no design" with the same field, and the graph should not have to
 * ask which one it was.
 */
function readDesignInput(payload: Record<string, unknown>): DesignInput {
  const raw = payload.figma ?? payload.figmaUrl;
  if (raw === undefined || raw === null) return { kind: 'none' };

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return { kind: 'none' };
    return isUrl(text) ? { kind: 'url', url: text } : { kind: 'text', text };
  }

  if (typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    const url = value.url;
    if (typeof url === 'string' && url.trim() !== '') {
      return { kind: 'url', url: url.trim() };
    }
    const text = value.text ?? value.description;
    if (typeof text === 'string' && text.trim() !== '') {
      return { kind: 'text', text: text.trim() };
    }
  }

  return { kind: 'none' };
}

/** The other documents of the answer. */
function readRefInputs(payload: Record<string, unknown>): RefInput[] {
  const raw = payload.docs ?? payload.documents;
  if (!Array.isArray(raw)) return [];

  const refs: RefInput[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const file = item.trim();
      if (file !== '') refs.push({ kind: 'file', path: file });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    const file = value.path;
    if (typeof file === 'string' && file.trim() !== '') {
      refs.push({ kind: 'file', path: file.trim() });
      continue;
    }
    const text = value.text;
    if (typeof text === 'string' && text.trim() !== '') {
      const name = typeof value.name === 'string' && value.name.trim() !== ''
        ? value.name.trim()
        : 'reference.md';
      refs.push({ kind: 'text', name, text: text.trim() });
    }
  }
  return refs;
}

/** Does the text look like a link? */
function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

/** The error of an answer without a usable PRD. */
function noPrd(answer: unknown): Error {
  return new Error(
    'the collect_prd gate expects a PRD — either the markdown itself, ' +
      '{"prd": "<markdown>"} or {"prd": {"path": "/absolute/path/to/PRD.md"}} ' +
      `— but got ${JSON.stringify(answer)}`
  );
}

/** A file the graph wrote, and where it came from. */
export interface CollectedFile {
  /** The key in the artifacts index. */
  key: string;
  /** The absolute path of the file. */
  path: string;
  /** Where the content came from. */
  source: string;
  /** How many bytes it has. */
  bytes: number;
}

/** What the graph wrote, and what it learned about the design. */
export interface CollectedInputs {
  /** Every file that was written. */
  files: CollectedFile[];
  /** The design the user gave: a link, a description, or nothing. */
  design: 'url' | 'text' | 'none';
  /** The Figma link, when there is one. */
  figmaUrl?: string;
}

/**
 * Write everything the user gave into the requirement directory.
 *
 * **The graph decides where things land**, so there is exactly one place
 * that knows it: the PRD is `prd.md`, a design described in words is
 * `design.md`, and the other documents are `refs/<name>`. The files are
 * written into the cloned repository, so they are committed together with
 * the code.
 *
 * @param docsDir - The requirement directory of the run.
 * @param inputs - What the user gave.
 * @returns The files that were written, and the design decision.
 * @throws Error when a file the user pointed at cannot be read. The message
 *   says which file and why - the gate shows it and asks again.
 */
export function writeCollectedInputs(docsDir: string, inputs: PrdInputs): CollectedInputs {
  fs.mkdirSync(docsDir, { recursive: true });

  const files: CollectedFile[] = [];

  // ---- the PRD ---------------------------------------------------------
  const prdPath = path.join(docsDir, PRD_FILE);
  const prdText = inputs.prd.kind === 'text' ? inputs.prd.text : readSourceFile(inputs.prd.path);
  writeText(prdPath, prdText);
  files.push({
    key: 'prd',
    path: prdPath,
    source: inputs.prd.kind === 'text' ? 'the user' : inputs.prd.path,
    bytes: Buffer.byteLength(prdText),
  });

  // ---- the design ------------------------------------------------------
  let design: 'url' | 'text' | 'none' = 'none';
  let figmaUrl: string | undefined;
  if (inputs.figma.kind === 'url') {
    design = 'url';
    figmaUrl = inputs.figma.url;
  } else if (inputs.figma.kind === 'text') {
    design = 'text';
    const designPath = path.join(docsDir, DESIGN_FILE);
    writeText(designPath, inputs.figma.text);
    files.push({
      key: 'design',
      path: designPath,
      source: 'the user',
      bytes: Buffer.byteLength(inputs.figma.text),
    });
  }

  // ---- the other documents ----------------------------------------------
  const refsDir = path.join(docsDir, REFS_DIR);
  const taken: string[] = [];
  for (const ref of inputs.docs) {
    const text = ref.kind === 'text' ? ref.text : readSourceFile(ref.path);
    const name = refsFileName(ref.kind === 'text' ? ref.name : path.basename(ref.path), taken);
    taken.push(name);
    const file = path.join(refsDir, name);
    fs.mkdirSync(refsDir, { recursive: true });
    writeText(file, text);
    files.push({
      key: `${REFS_DIR}/${name}`,
      path: file,
      source: ref.kind === 'text' ? 'the user' : ref.path,
      bytes: Buffer.byteLength(text),
    });
  }

  return { files, design, ...(figmaUrl !== undefined ? { figmaUrl } : {}) };
}

/**
 * The name a reference document gets inside `refs/`.
 *
 * Two documents with the same name must not overwrite each other: the second
 * one becomes `name-2.md`, the third `name-3.md`.
 *
 * @param name - The wanted name.
 * @param taken - The names that are already used.
 */
export function refsFileName(name: string, taken: string[]): string {
  const cleaned = sanitizeName(name);
  if (!taken.includes(cleaned)) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** A name that is safe to write into a directory. */
function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'reference.md';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

/** Write a text file, with a trailing newline. */
function writeText(file: string, text: string): void {
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf-8');
}

/**
 * The artifacts index of the collected files.
 *
 * The state only holds **indicators** - where a file is and what it looked
 * like - not the content itself. The content is on disk, in the repository.
 *
 * @param files - The files that were written.
 */
export function artifactsOf(files: CollectedFile[]): Record<string, { path: string; hash: string; updatedAt: string }> {
  const index: Record<string, { path: string; hash: string; updatedAt: string }> = {};
  const updatedAt = new Date().toISOString();
  for (const file of files) {
    index[file.key] = { path: file.path, hash: hashOf(file.path), updatedAt };
  }
  return index;
}

/** The hash of a file. */
function hashOf(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/**
 * A short description of what was collected, for the confirmation gate.
 *
 * The user approves the PRD without seeing what the graph actually read -
 * the gate shows them this, so an answer that was read from the wrong file
 * is visible before it becomes a spec.
 *
 * @param collected - What was written.
 */
export function collectedSummary(collected: CollectedInputs): Record<string, unknown> {
  const prd = collected.files.find((file) => file.key === 'prd');
  return {
    prd: prd ? { source: prd.source, bytes: prd.bytes } : undefined,
    design:
      collected.design === 'url'
        ? { kind: 'url', url: collected.figmaUrl }
        : collected.design === 'text'
          ? { kind: 'text', bytes: collected.files.find((f) => f.key === 'design')?.bytes ?? 0 }
          : { kind: 'none' },
    docs: collected.files
      .filter((file) => file.key.startsWith(`${REFS_DIR}/`))
      .map((file) => ({ name: path.basename(file.path), source: file.source, bytes: file.bytes })),
  };
}
