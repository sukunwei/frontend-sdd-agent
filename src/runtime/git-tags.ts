import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The git tags of the TDD loop.
 *
 * The rollback of the escalation ladder needs a point the code can go back
 * to: the implementation plan (§8.4) wants `git reset --hard
 * sdd/task/<id>/start` on the second failure of a task, and nothing but a tag
 * can carry that point.
 *
 * **The tag is the state of the repository at the moment the task starts.**
 * It is created before the developer work order goes out, so that everything
 * the developer writes afterwards is *after* the tag - which is exactly what
 * a rollback has to discard.
 *
 * **All git calls go through `execFileSync` with an argument list.** A
 * repository URL is user input, and a shell string would turn it into an
 * injection sink; the argument list never reaches a shell. This is the
 * convention of `src/runtime/git-branch-manager.ts`.
 */

/** The name of the tag that marks the start of a task. */
export function taskStartTag(taskId: string): string {
  return `sdd/task/${taskId}/start`;
}

/**
 * Tag the start of a task.
 *
 * **An existing tag is never recreated.** The tag is the point a rollback
 * goes back to, and moving it to a later commit would move the rollback point
 * with it - a second failure would then roll back to the middle of the work
 * that is being rolled back. The tag therefore stays where it was put.
 *
 * **One git process, not two.** The node asks for the tag before every
 * developer order, and a git process costs hundreds of milliseconds - so the
 * tag is created straight away and an "already exists" is recognized from the
 * error instead of from a second `rev-parse`. The messages of git are read
 * in the C locale (`LC_ALL=C`), so that the text is the same everywhere.
 *
 * @param repoDir - The repository of the run.
 * @param taskId - The id of the task (`TASK-<slug>`).
 * @returns The name of the tag and whether this call created it.
 * @throws Error when the tag cannot be created.
 */
export function tagTaskStart(repoDir: string, taskId: string): { created: boolean; tag: string } {
  const tag = taskStartTag(taskId);
  try {
    execFileSync('git', ['-C', repoDir, 'tag', tag], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    return { created: true, tag };
  } catch (err) {
    // The tag is there already: that is the normal case, not a failure.
    if (stderrOf(err).includes('already exists') || tagExists(repoDir, tag)) {
      return { created: false, tag };
    }
    throw new Error(
      `cannot tag the start of ${taskId} in ${repoDir}: ${messageOf(err)}`
    );
  }
}

/**
 * Is the directory a git repository?
 *
 * A workspace that was never cloned has no tag to create and nothing to roll
 * back to, so the caller may skip the tag instead of failing.
 *
 * **The check reads the file system, not git.** The TDD node asks this
 * question before every developer order, and a git process costs hundreds of
 * milliseconds - the `.git` entry of a clone is enough to tell a repository
 * from an empty directory.
 *
 * **The contract: `repoDir` is the root of the work tree.** The check looks
 * for the `.git` entry *in that directory*; it does not walk up the tree. A
 * directory inside a repository (a subdirectory of the work tree) is
 * therefore **not** a repository as far as this function is concerned - the
 * caller has to pass the root of the work tree.
 */
export function isGitRepository(repoDir: string): boolean {
  return fs.existsSync(path.join(repoDir, '.git'));
}

/**
 * Roll the repository back to the start of a task.
 *
 * `git reset --hard sdd/task/<id>/start` - the working tree and the branch
 * go back to the tagged commit.
 *
 * **The call is idempotent**: resetting to the same tag twice leaves the
 * repository in the same state, so the escalation ladder may call it before
 * it raises an interrupt without having to know whether it already ran.
 *
 * @param repoDir - The repository of the run.
 * @param taskId - The id of the task (`TASK-<slug>`).
 * @returns true when the repository was rolled back.
 */
export function resetToTaskStart(repoDir: string, taskId: string): boolean {
  const tag = taskStartTag(taskId);
  try {
    execFileSync('git', ['-C', repoDir, 'reset', '--hard', tag], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    // The tag does not exist (the task never started) or the repository is
    // not a repository: there is nothing to roll back to.
    return false;
  }
}

/**
 * Does the tag exist?
 *
 * `git rev-parse --verify` is the cheap way to ask: it fails when the
 * reference does not resolve, and it never writes anything.
 */
function tagExists(repoDir: string, tag: string): boolean {
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/tags/${tag}`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** The message of an error. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What git wrote to stderr. */
function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr === 'string') return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf-8');
  return '';
}
