/**
 * The JSON envelopes the CLI prints.
 *
 * The host reads stdout as JSON and branches on the exit code:
 *
 * | exit | stdout                          | stderr        |
 * |------|---------------------------------|---------------|
 * | 0    | `{"kind":"result",...}`         | -             |
 * | 2    | `{"kind":"interrupt",...}`       | -             |
 * | 1    | -                               | `{"kind":"error",...}` |
 *
 * Every envelope is a **single line**: the host parses stdout as one JSON
 * document, so a pretty-printed envelope would break it.
 */

/** Kind of an envelope. */
export type EnvelopeKind = 'interrupt' | 'error' | 'result';

/**
 * Serialize an envelope into a single line of JSON.
 *
 * The `kind` comes first so a reader can branch on it without parsing the
 * whole document; the body is spread after it.
 */
export function envelope(kind: EnvelopeKind, body: unknown): string {
  return JSON.stringify({ kind, ...(body as object) });
}

/** Envelope of a pending interrupt (exit code 2). */
export interface InterruptEnvelope {
  kind: 'interrupt';
  /** Who has to act: a human (`user`) or the session (`host`). */
  audience: 'user' | 'host';
  /** Type of the interrupt (e.g. `collect_prd`, `work_order`). */
  type: string;
  /** Thread the interrupt belongs to (= the normalized task name). */
  threadId: string;
  /** Stage the graph was in when it parked. */
  stage: string;
  /** The interrupt payload itself. */
  payload: unknown;
  /** Id of the pending interrupt, for logging. */
  interruptId?: string;
  /**
   * A hint for the user that is not part of the interrupt itself
   * (e.g. `請把 /.sdd/ 加進 .gitignore`).
   */
  notice?: string;
}

/** Envelope of a finished command (exit code 0). */
export interface ResultEnvelope {
  kind: 'result';
  /** Stage the graph is in (absent when the command does not touch the graph). */
  stage?: string;
  /** Thread the command worked on. */
  threadId: string;
  /** The pending interrupt, when the command reports one. */
  pending?: { audience: string; type: string } | null;
  /** Extra, command specific fields. */
  [key: string]: unknown;
}

/** Envelope of a failed command (exit code 1). */
export interface ErrorEnvelope {
  kind: 'error';
  /** Machine readable reason (`invalid_arguments`, `audience_mismatch`, ...). */
  code: string;
  /** Human readable explanation. */
  message: string;
}
