import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A local git repository a test can really clone.
 *
 * The clone the bootstrap node does is executed for real (argv arrays, no
 * shell), so the tests need a repository that exists - a `file://` URL of a
 * local repository is the cheapest one that behaves like a remote.
 */
export interface GitFixture {
  /** The `file://` URL of the repository. */
  url: string;
  /** The directory the repository lives in. */
  dir: string;
  /** Remove the fixture. */
  cleanup(): void;
}

/** Create a local git repository with one commit on `main`. */
export function createGitFixture(prefix = 'sdd-git-'): GitFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  };
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'sdd-graph test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return {
    url: `file://${dir}`,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Clone a fixture into a directory.
 *
 * The target may exist and be empty (that is what the workspace looks like
 * before the clone) - git is happy with both.
 */
export function cloneFixture(url: string, targetDir: string): void {
  execFileSync('git', ['clone', url, targetDir], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
