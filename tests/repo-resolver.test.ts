import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveRepo,
  isRemoteSpec,
  gitTopLevel,
  RepoResolutionError,
} from '../src/runtime/repo-resolver.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { GitFixture } from './helpers/git-fixture.js';

describe('倉庫解析', () => {
  let fixture: GitFixture;

  beforeEach(() => {
    fixture = createGitFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('URL 形態走 remote', () => {
    expect(isRemoteSpec('https://github.com/x/y.git')).toBe(true);
    expect(isRemoteSpec('git@github.com:x/y.git')).toBe(true);
    expect(isRemoteSpec('file:///tmp/repo')).toBe(true);
    expect(isRemoteSpec('/tmp/repo')).toBe(false);
    expect(isRemoteSpec('.')).toBe(false);
  });

  it('以 .git 結尾也算 remote', () => {
    expect(isRemoteSpec('/tmp/some/repo.git')).toBe(true);
  });

  it('file:// 前綴判成 remote，保留「從本地路徑克隆」的舊用法', () => {
    const resolved = resolveRepo(fixture.url, process.cwd());
    expect(resolved.mode).toBe('remote');
    expect(resolved.remoteUrl).toBe(fixture.url);
    // clone 目標目錄由呼叫端決定，解析器不猜。
    expect(resolved.repoRoot).toBe('');
  });

  it('缺省時用 cwd', () => {
    const resolved = resolveRepo(undefined, fixture.dir);
    expect(resolved.mode).toBe('local');
    expect(resolved.repoRoot).toBe(fs.realpathSync(fixture.dir));
    expect(resolved.remoteUrl).toBeUndefined();
  });

  it('本地路徑解析出倉庫真實根（子目錄也認）', () => {
    const sub = path.join(fixture.dir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveRepo(sub, process.cwd()).repoRoot).toBe(fs.realpathSync(fixture.dir));
  });

  it('相對路徑依 cwd 解析', () => {
    expect(resolveRepo('.', fixture.dir).repoRoot).toBe(fs.realpathSync(fixture.dir));
  });

  it('不存在的路徑報 validation_error 且消息同時提示兩種可能', () => {
    let caught: unknown;
    try {
      resolveRepo('/tmp/definitely-not-here', process.cwd());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RepoResolutionError);
    const error = caught as RepoResolutionError;
    expect(error.code).toBe('validation_error');
    // 路徑寫錯與 URL 寫錯是同一種「看起來對其實不對」，兩種解釋都要講。
    expect(error.message).toMatch(/路徑不存在/);
    expect(error.message).toMatch(/repository URL/i);
  });

  it('非 git 目錄報錯', () => {
    expect(() => resolveRepo(os.tmpdir(), process.cwd())).toThrowError(/不是 git 倉庫/);
  });

  it('gitTopLevel 對非 git 目錄回傳 undefined，對倉庫子目錄回傳倉庫根', () => {
    expect(gitTopLevel(os.tmpdir())).toBeUndefined();
    expect(gitTopLevel(fixture.dir)).toBe(fs.realpathSync(fixture.dir));
  });
});
