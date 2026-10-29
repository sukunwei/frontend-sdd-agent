import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Single source of truth for every filesystem path in the plugin.
 *
 * The plugin root is found by walking UP from this module's own location until
 * a directory containing `.claude-plugin/plugin.json` shows up. That is
 * layout-independent: it works whether the code runs from `src/runtime/`
 * (tsx) or from `dist/src/runtime/` (compiled), which a fixed
 * `path.resolve(__dirname, '../../..')` does not.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAX_PARENT_WALK = 6;

/**
 * Resolve the plugin root (the directory holding `.claude-plugin/plugin.json`).
 * @throws Error if no ancestor directory contains the plugin manifest.
 */
export function getPluginRoot(): string {
  let dir = HERE;
  for (let i = 0; i < MAX_PARENT_WALK; i += 1) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('plugin root not found');
}

/**
 * Base directory holding one sub-directory per task workspace.
 * Override with SDD_GRAPH_WORKSPACE_BASE (tests point this at a temp dir).
 * The override is resolved to an absolute path so every derived work-order
 * path stays absolute even when the variable holds a relative value.
 */
export function getWorkspaceBase(): string {
  const override = process.env.SDD_GRAPH_WORKSPACE_BASE;
  if (override) {
    return path.resolve(override);
  }
  return path.join(getPluginRoot(), 'workspace', 'tasks');
}

/**
 * Task workspace directory.
 * Format: <workspace-base>/<taskName>
 */
export function getTaskDir(taskName: string): string {
  return path.join(getWorkspaceBase(), taskName);
}

/**
 * Cloned repository directory.
 * Format: <task-dir>/repo
 */
export function getRepoDir(taskName: string): string {
  return path.join(getTaskDir(taskName), 'repo');
}

/**
 * Requirement documents live INSIDE the cloned repo so they are committed
 * together with the code.
 * Format: <repo-dir>/docs/<requirementName>
 *
 * @param requirementName - Normalized requirement name (== normalized task name)
 * @param repoDir - Optional explicit repo directory (fixtures/tests)
 */
export function getDocsDir(requirementName: string, repoDir?: string): string {
  return path.join(repoDir ?? getRepoDir(requirementName), 'docs', requirementName);
}

/**
 * Verification log directory of a resolved docs directory.
 * Format: <docs-dir>/verify
 */
export function getVerifyLogDirFromDocs(docsDir: string): string {
  return path.join(docsDir, 'verify');
}

/**
 * Verification log directory.
 * Format: <docs-dir>/verify
 */
export function getVerifyLogDir(requirementName: string, repoDir?: string): string {
  return getVerifyLogDirFromDocs(getDocsDir(requirementName, repoDir));
}

/**
 * Global branch runtime lock file.
 * Format: <plugin-root>/runtime/branch-runtime-lock.json
 *
 * The path is **not** configurable through the environment: the lock is
 * global, and an environment variable that silently points it somewhere else
 * would let two runs use two different locks. Callers that need another file
 * (the tests) pass it explicitly - `buildGraph({ lockPath })` and the
 * `lockPath` option of the lock functions.
 */
export function getLockFilePath(): string {
  return path.join(getPluginRoot(), 'runtime', 'branch-runtime-lock.json');
}

/**
 * LangGraph checkpoint database.
 * Format: <plugin-root>/runtime/checkpoints.sqlite
 */
export function getCheckpointPath(): string {
  return path.join(getPluginRoot(), 'runtime', 'checkpoints.sqlite');
}

/**
 * Run metadata file.
 * Format: <task-dir>/run-metadata.json
 */
export function getRunMetadataPath(taskName: string): string {
  return path.join(getTaskDir(taskName), 'run-metadata.json');
}

/**
 * The body of a work order.
 *
 * Every work order is a prompt file: the graph reads the file, the host
 * reads the text the CLI hands it.
 *
 * Format: <plugin-root>/prompts/<name>.md
 *
 * @param name - Name of the prompt (without the `.md` suffix).
 * @param promptsDir - The directory the prompt files live in. Defaults to
 *   the plugin root; the tests point it at a temp dir, so that a test never
 *   writes into the directory the plugin ships.
 */
export function getPromptPath(name: string, promptsDir?: string): string {
  return path.join(promptsDir ?? path.join(getPluginRoot(), 'prompts'), `${name}.md`);
}

/**
 * Read a document of the run.
 *
 * A document that does not exist reads as an empty one; a document that
 * exists but cannot be read is an error - **a broken document is not an
 * empty document**, and the two must not look the same to the gates.
 *
 * @param file - Absolute path of the document.
 * @throws Error when the file exists but cannot be read.
 */
export function readDoc(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

/**
 * Read the body of a work order.
 *
 * @param name - Name of the prompt (without the `.md` suffix).
 * @param promptsDir - The directory the prompt files live in. Defaults to
 *   the plugin root; the tests point it at a temp dir.
 * @throws Error when the prompt file cannot be read - a work order without a
 *   body cannot be worked.
 */
export function readPrompt(name: string, promptsDir?: string): string {
  const file = getPromptPath(name, promptsDir);
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read the work order prompt "${name}" (${file}): ${reason}`);
  }
}
