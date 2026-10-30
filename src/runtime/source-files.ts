import * as fs from 'fs';

/**
 * Reading the files the user points at.
 *
 * The user answers the `collect_prd` gate with a **path** ("the PRD is at
 * /Users/me/PRD.md") or with text. The graph reads the path itself: the
 * landing spot of everything is decided in one place, and the content never
 * passes through the conversation - nothing rewrites or summarises it on the
 * way in.
 *
 * **Only text.** A PRD is a document the spec writer has to read; a PDF or a
 * Word file is a document *about* a document, and copying its bytes into
 * `prd.md` would give the spec writer something it cannot read. The error
 * says what to do instead.
 */

/** The biggest source file the graph will copy into the repository (4 MB). */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** How many bytes are inspected when looking for binary content. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Read a text file the user pointed at.
 *
 * @param file - The absolute path of the file.
 * @returns The content of the file.
 * @throws Error when the file cannot be used: it does not exist, it is a
 *   directory, it is not text, or it is too big. The message says what is
 *   wrong and what to do about it - the gate shows it to the user.
 */
export function readSourceFile(file: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    throw new Error(`cannot read ${file}: no such file`);
  }

  if (stats.isDirectory()) {
    throw new Error(`${file} is a directory — point at a single file`);
  }
  if (!stats.isFile()) {
    throw new Error(`cannot read ${file}: not a regular file`);
  }
  if (stats.size > MAX_SOURCE_BYTES) {
    const mb = (stats.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `${file} is too large (${mb} MB) — the limit is ` +
        `${MAX_SOURCE_BYTES / (1024 * 1024)} MB. Split it, or point at the part that matters.`
    );
  }

  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read ${file}: ${reason}`);
  }

  if (isBinary(content)) {
    throw new Error(
      `${file} is not a text file — export it as markdown (or plain text) and point at that`
    );
  }

  return content.toString('utf-8');
}

/**
 * Is the content binary?
 *
 * A NUL byte in the first block is the usual tell: text files do not have
 * them, and every binary format worth rejecting has one early.
 *
 * @param content - The bytes of the file.
 */
function isBinary(content: Buffer): boolean {
  const head = content.subarray(0, BINARY_SNIFF_BYTES);
  return head.includes(0);
}
