import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cloneBranch,
  getCurrentBranch,
  getDefaultBranch,
  getGitStatus,
  remoteBranchExists,
} from '../src/runtime/git-branch-manager.js';

/**
 * These tests exercise the git helpers against a local `file://` repository so
 * the argv-array `execFileSync` calls are actually executed (no shell involved).
 *
 * Both temp directories deliberately contain a space: the previous
 * `execSync('git ... ' + repoUrl)` form interpolated unquoted paths, so any
 * path with a space was split into two arguments and git failed outright.
 */
const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd git remote-'));
const workspaceBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd git ws-'));
const remoteUrl = `file://${remoteDir}`;

/** Injection marker directory — deliberately free of spaces so the injected
 *  command would succeed if a shell ever interpreted the branch name. */
const injectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-inject-'));

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  git(['init', '--initial-branch=main'], remoteDir);
  git(['config', 'user.email', 'test@example.com'], remoteDir);
  git(['config', 'user.name', 'sdd-graph test'], remoteDir);
  fs.writeFileSync(path.join(remoteDir, 'README.md'), '# fixture\n');
  git(['add', '.'], remoteDir);
  git(['commit', '-m', 'init'], remoteDir);
  git(['branch', 'task/existing'], remoteDir);
});

afterEach(() => {
  delete process.env.SDD_GRAPH_WORKSPACE_BASE;
});

afterAll(() => {
  fs.rmSync(remoteDir, { recursive: true, force: true });
  fs.rmSync(workspaceBase, { recursive: true, force: true });
  fs.rmSync(injectDir, { recursive: true, force: true });
});

describe('git branch manager（execFileSync argv 陣列，無 shell）', () => {
  it('remoteBranchExists 對 file:// 本地 repo 回報分支是否存在', () => {
    expect(remoteBranchExists(remoteUrl, 'task/existing')).toBe(true);
    expect(remoteBranchExists(remoteUrl, 'task/missing')).toBe(false);
  });

  it('repoUrl 含空白時仍能正確解析（舊的未加引號 shell 形式會失敗）', () => {
    expect(remoteDir).toContain(' ');
    expect(remoteBranchExists(remoteUrl, 'task/existing')).toBe(true);
  });

  it('分支名中的 shell 元字元不會被 shell 執行', () => {
    const marker = path.join(injectDir, 'pwned.txt');
    const hostile = `task/x;touch ${marker}`;

    expect(remoteBranchExists(remoteUrl, hostile)).toBe(false);
    // 舊的 execSync 形式會讓 `;` 之後的指令被 shell 執行，產生這個檔案
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('getDefaultBranch 讀出遠端預設分支', () => {
    expect(getDefaultBranch(remoteUrl)).toBe('main');
  });

  it('getCurrentBranch 與 getGitStatus 讀取本地 repo 狀態', () => {
    expect(getCurrentBranch(remoteDir)).toBe('main');
    expect(getGitStatus(remoteDir)).toEqual({
      isClean: true,
      currentBranch: 'main',
      hasChanges: false,
      stagedChanges: 0,
      unstagedChanges: 0,
    });
  });

  it('cloneBranch 克隆到工作區並在遠端建立新分支', () => {
    process.env.SDD_GRAPH_WORKSPACE_BASE = workspaceBase;
    const result = cloneBranch(remoteUrl, 'task/created', 'clone-task');

    expect(result.success).toBe(true);
    expect(result.branch).toBe('task/created');
    expect(result.repoPath).toBe(path.join(workspaceBase, 'clone-task', 'repo'));
    expect(getCurrentBranch(result.repoPath)).toBe('task/created');
    expect(remoteBranchExists(remoteUrl, 'task/created')).toBe(true);
  });

  it('cloneBranch 克隆遠端已存在的分支', () => {
    process.env.SDD_GRAPH_WORKSPACE_BASE = workspaceBase;
    const result = cloneBranch(remoteUrl, 'task/existing', 'existing-task');

    expect(result.success).toBe(true);
    expect(getCurrentBranch(result.repoPath)).toBe('task/existing');
  });
});
