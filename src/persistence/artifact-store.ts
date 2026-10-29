import * as fs from 'fs';
import * as path from 'path';
import { getDocsDir } from '../runtime/paths.js';
import { WorkflowStateSchema } from '../state/schema.js';
import type { SddState } from '../state/types.js';

const STATE_FILE = 'workflow-state.json';
const TIMELINE_FILE = 'timeline.md';

/**
 * Writes the human-facing mirror of the graph state.
 *
 * The mirror (`workflow-state.json` + `timeline.md`) lives inside the cloned
 * repository, next to the documents it describes, so it can be committed and
 * read without knowing anything about the plugin runtime.
 *
 * Two rules the rest of the system relies on:
 *
 * 1. **The graph owns the mirror.** Every `sync()` fully overwrites
 *    `workflow-state.json`; a host that hand-edits the file has its edit
 *    replaced, never merged.
 * 2. **Writes are atomic.** The document goes to a `.tmp` sibling first and is
 *    then renamed into place, so a crash can never leave a half-written
 *    mirror behind.
 */
export class ArtifactStore {
  /**
   * @param requirementName - Normalized requirement name (== normalized task name)
   * @param repoDir - Optional explicit repo directory (fixtures/tests)
   */
  constructor(
    private readonly requirementName: string,
    private readonly repoDir?: string
  ) {}

  /** Directory holding the mirror. */
  get docsDir(): string {
    return getDocsDir(this.requirementName, this.repoDir);
  }

  /** Path of the state mirror. */
  get statePath(): string {
    return path.join(this.docsDir, STATE_FILE);
  }

  /** Path of the human-readable timeline. */
  get timelinePath(): string {
    return path.join(this.docsDir, TIMELINE_FILE);
  }

  /**
   * Write the state mirror.
   *
   * The state is normalized through the 1.1.0 schema first, so the document
   * on disk is always a complete, canonical mirror (fields the graph left out
   * are filled with their defaults).
   *
   * @throws Error when the state does not conform to the 1.1.0 schema.
   */
  sync(state: SddState): void {
    const now = new Date().toISOString();
    const doc = this.parseState({
      ...state,
      requirementName: state.requirementName || this.requirementName,
      createdAt: state.createdAt || now,
      updatedAt: now,
    });

    const target = this.statePath;
    const tmp = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  /**
   * Read the state mirror back.
   *
   * @returns The parsed state, or `null` when there is no usable mirror. A
   *   missing, unreadable or unparsable file counts as "no mirror": the
   *   mirror is owned by the graph, so the next `sync()` overwrites whatever a
   *   host put there instead of crashing the run.
   */
  load(): SddState | null {
    if (!fs.existsSync(this.statePath)) return null;

    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
    } catch {
      return null;
    }

    const parsed = WorkflowStateSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  /** Append one timestamped line to the timeline. */
  appendTimeline(entry: string): void {
    fs.mkdirSync(path.dirname(this.timelinePath), { recursive: true });
    if (!fs.existsSync(this.timelinePath)) {
      fs.writeFileSync(this.timelinePath, '# Timeline\n', 'utf-8');
    }
    fs.appendFileSync(this.timelinePath, `- [${new Date().toISOString()}] ${entry}\n`, 'utf-8');
  }

  /** Validate against the 1.1.0 schema, with a readable error message. */
  private parseState(raw: unknown): SddState {
    const parsed = WorkflowStateSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`invalid workflow state: ${detail}`);
    }
    return parsed.data;
  }
}
