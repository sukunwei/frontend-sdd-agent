import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  isWorktreeDirty,
  currentBranchName,
  prepareLocalBranch,
  GIT_READ_TIMEOUT_MS,
  GIT_WRITE_TIMEOUT_MS,
} from '../src/runtime/git-branch-manager.js';

/**
 * 這些測試是真的在臨時目錄裡跑 git（不是 mock），
 * 因為「髒不髒」這個判定的口徑就是 git 命令的輸出本身，
 * mock 掉 git 等於把要測的東西也 mock 掉了。
 */
describe('本地分支準備', () => {
  let dir: string;
  let extraDirs: string[];

  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-branch-'));
    extraDirs = [];
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const extra of extraDirs) {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it('乾淨的工作區可以建分支', () => {
    const r = prepareLocalBranch(dir, 'task/x');
    expect(r.ok).toBe(true);
    expect(r.branch).toBe('task/x');
    expect(r.currentBranch).toBe('main');
    expect(r.dirty).toBe(false);
    expect(currentBranchName(dir)).toBe('task/x');
  });

  it('已跟蹤文件被改 → 判定為髒', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    expect(isWorktreeDirty(dir)).toBe(true);
  });

  it('只有未跟蹤文件 → 不算髒', () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    expect(isWorktreeDirty(dir)).toBe(false);
  });

  it('已加入索引（staged）的檔案算髒——它已經被 git 追蹤了', () => {
    // 口徑是 git 的 `--untracked-files=no`：只有「不在索引裡」的文件才被排除。
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'x');
    git(['add', 'staged.txt']);
    expect(isWorktreeDirty(dir)).toBe(true);
  });

  it('只有未跟蹤文件時照樣放行建分支', () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    const r = prepareLocalBranch(dir, 'task/x');
    expect(r.ok).toBe(true);
    expect(r.branch).toBe('task/x');
    expect(r.dirty).toBe(false);
  });

  it('skipSwitch 時留在當前分支', () => {
    const r = prepareLocalBranch(dir, 'task/x', { skipSwitch: true });
    expect(r.ok).toBe(true);
    expect(r.branch).toBe('main');
    expect(r.currentBranch).toBe('main');
    expect(currentBranchName(dir)).toBe('main');
  });

  it('skipSwitch 時回報的是當前分支名，不是目標分支名', () => {
    // run-metadata 要記「真的所在」的分支，記成沒去過的分支會誤導後續流程。
    const r = prepareLocalBranch(dir, 'task/x', { skipSwitch: true });
    expect(r.branch).not.toBe('task/x');
    expect(r.branch).toBe(currentBranchName(dir));
  });

  it('分支已存在則切換過去', () => {
    git(['branch', 'task/x']);
    const r = prepareLocalBranch(dir, 'task/x');
    expect(r.ok).toBe(true);
    expect(r.branch).toBe('task/x');
    expect(r.currentBranch).toBe('main');
    expect(currentBranchName(dir)).toBe('task/x');
  });

  it('已跟蹤文件被改 → 不切分支，回報髒並拒絕', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    const r = prepareLocalBranch(dir, 'task/x');
    expect(r.ok).toBe(false);
    expect(r.dirty).toBe(true);
    expect(r.errorCode).toBe('git_error');
    expect(r.error).toBeTruthy();
    // 使用者正在寫的東西不能被帶到別的分支上
    expect(currentBranchName(dir)).toBe('main');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8')).toBe('changed');
  });

  it('髒工作區 + skipSwitch → 留在當前分支並回報髒', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    const r = prepareLocalBranch(dir, 'task/x', { skipSwitch: true });
    expect(r.ok).toBe(true);
    expect(r.branch).toBe('main');
    expect(r.dirty).toBe(true);
    expect(currentBranchName(dir)).toBe('main');
  });

  it('分支被另一個 worktree 佔用 → 帶出 git 的原始錯誤訊息', () => {
    git(['branch', 'task/x']);
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-wt-'));
    extraDirs.push(wtParent);
    const wtPath = path.join(wtParent, 'wt');
    git(['worktree', 'add', wtPath, 'task/x']);

    const r = prepareLocalBranch(dir, 'task/x');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('git_error');
    // git 說什麼就帶什麼——使用者要分得出「worktree 佔用」跟別的錯誤
    expect(r.error).toMatch(/already checked out at/);
    expect(r.error).toMatch(/worktree/);
    expect(r.branch).toBe('main');
    expect(currentBranchName(dir)).toBe('main');
  });

  it('不是 git 倉庫時回報 git_error 而不是丟例外', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-notrepo-'));
    extraDirs.push(notRepo);
    const r = prepareLocalBranch(notRepo, 'task/x');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('git_error');
    expect(r.error).toBeTruthy();
  });

  it('查不到工作區狀態時 dirty 不是 false（false 會被讀成「乾淨」）', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-notrepo2-'));
    extraDirs.push(notRepo);
    const r = prepareLocalBranch(notRepo, 'task/x');
    expect(r.ok).toBe(false);
    // 「不知道」跟「乾淨」要分得開
    expect(r.dirty).toBeUndefined();
  });

  it('checkout 用獨立且明顯較長的逾時（不能被砍在半路）', () => {
    // 寫操作被砍半會留下「索引已更新、檔案沒寫完」的半完成狀態，
    // 那是在使用者真實的倉庫上動手，代價太高。
    expect(GIT_READ_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(GIT_WRITE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(GIT_WRITE_TIMEOUT_MS).toBeGreaterThan(GIT_READ_TIMEOUT_MS);
  });

  it('currentBranchName 在沒有 commit 的空倉庫回傳 HEAD', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-empty-'));
    extraDirs.push(empty);
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: empty,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(currentBranchName(empty)).toBe('HEAD');
  });

  it('detached HEAD → 回傳 HEAD，代表「不在任何分支上」而不是一個分支名', () => {
    const sha = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', sha]);
    // 'HEAD' 不是分支名：呼叫端不能把它當成分支寫進 run-metadata。
    expect(currentBranchName(dir)).toBe('HEAD');
    // 真的在分支上時回真正的分支名
    git(['checkout', 'main']);
    expect(currentBranchName(dir)).toBe('main');
  });
});
