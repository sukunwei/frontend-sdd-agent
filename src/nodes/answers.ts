/**
 * The answers the user gives to the gates of the graph.
 *
 * **An answer is a payload, not a string.** The host may answer a gate with
 * a plain string, with an object that carries the answer in one of several
 * fields, or with something the graph has never seen. The graph does not
 * assume a shape it has not agreed on, so every field is read defensively.
 *
 * **An answer that cannot be read is not "no answer".** The two are very
 * different: "no answer" means the user has not answered yet, while an
 * unreadable answer means the user *did* answer and the graph did not
 * understand it. If the two were the same, the gate would be asked again and
 * again and the answer of the user would be swallowed - `interrupt()` on the
 * resume path hands the node the *next* queued answer, so the real answer
 * would be lost instead of being surfaced.
 */

/** The answer of a user gate, as the graph reads it. */
export interface GateAnswer {
  /** The answer itself (`wait`, `skip`, ...). */
  value: string;
  /** The answer could not be read - the raw payload is in {@link raw}. */
  unparsed: boolean;
  /** The answer as it came in (for the diagnostic). */
  raw: string;
}

/**
 * The fields an answer may carry its text in.
 *
 * The list is deliberately wide: the host is a program that may name the
 * field the way it likes, and a gate that only understands one name throws
 * the answer of the user away.
 */
const ANSWER_KEYS = [
  'action',
  'answer',
  'comment',
  'text',
  'option',
  'value',
  'response',
  'decision',
  'choice',
] as const;

/**
 * Read the answer of a gate.
 *
 * @param answer - The value the gate was answered with.
 * @returns The answer, and whether it could be read at all.
 */
export function readAnswer(answer: unknown): GateAnswer {
  if (typeof answer === 'string') {
    const value = answer.trim();
    return { value, unparsed: value === '', raw: answer };
  }

  if (typeof answer === 'object' && answer !== null) {
    const payload = answer as Record<string, unknown>;
    for (const key of ANSWER_KEYS) {
      const text = payload[key];
      if (typeof text === 'string' && text.trim() !== '') {
        return { value: text.trim(), unparsed: false, raw: describe(answer) };
      }
    }
  }

  return { value: '', unparsed: true, raw: describe(answer) };
}

/**
 * A readable description of a raw answer.
 *
 * The description goes into the diagnostic of the gate that is asked again:
 * the user has to see what the graph did not understand.
 *
 * @param answer - The value the gate was answered with.
 */
function describe(answer: unknown): string {
  if (answer === undefined) return 'undefined';
  if (answer === null) return 'null';
  try {
    return JSON.stringify(answer) ?? String(answer);
  } catch {
    return String(answer);
  }
}
