import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  setRunContext,
  getRunContext,
  resetRunContext,
  isLocalMode,
  defaultSddHome,
} from '../src/runtime/run-context.js';
import {
  getCheckpointPath,
  getLockFilePath,
  getRunMetadataPath,
  getPluginRoot,
  getTaskDir,
  getRepoDir,
} from '../src/runtime/paths.js';

afterEach(() => {
  resetRunContext();
  delete process.env.SDD_GRAPH_SDD_HOME;
});

describe('運行上下文', () => {
  it('未設置上下文時退回外掛根的 remote 行為', () => {
    expect(getRunContext().mode).toBe('remote');
    expect(getCheckpointPath()).toBe(`${getPluginRoot()}/runtime/checkpoints.sqlite`);
    expect(getLockFilePath()).toBe(`${getPluginRoot()}/runtime/branch-runtime-lock.json`);
    expect(isLocalMode()).toBe(false);
  });

  it('設置 local 上下文後 checkpoint 與 lock 落在 .sdd 之下', () => {
    setRunContext({ mode: 'local', repoRoot: '/tmp/repo', sddHome: '/tmp/repo/.sdd', workspaceBase: '/tmp/ws' });
    expect(getCheckpointPath()).toBe('/tmp/repo/.sdd/checkpoints.sqlite');
    expect(getLockFilePath()).toBe('/tmp/repo/.sdd/branch-lock.json');
    expect(getRunMetadataPath('t1')).toBe('/tmp/repo/.sdd/runs/t1/run-metadata.json');
    expect(isLocalMode()).toBe(true);
  });

  it('SDD_GRAPH_SDD_HOME 可覆寫 .sdd 根', () => {
    process.env.SDD_GRAPH_SDD_HOME = '/tmp/other-sdd';
    expect(defaultSddHome('/tmp/repo')).toBe('/tmp/other-sdd');
    delete process.env.SDD_GRAPH_SDD_HOME;
    expect(defaultSddHome('/tmp/repo')).toBe(path.join('/tmp/repo', '.sdd'));
  });

  it('local 模式下 task 與 repo 目錄必須留在 .sdd 之下（清理函式會遞迴刪除）', () => {
    setRunContext({ mode: 'local', repoRoot: '/tmp/repo', sddHome: '/tmp/repo/.sdd', workspaceBase: '/tmp/ws' });
    expect(getTaskDir('t1')).toBe('/tmp/repo/.sdd/tasks/t1');
    expect(getRepoDir('t1')).toBe('/tmp/repo/.sdd/tasks/t1/repo');
    // 絕不能落在業務倉庫裡——getRepoDir 是遞迴刪除的目標，只能在 .sdd 之下
    expect(getRepoDir('t1').startsWith('/tmp/repo/.sdd/')).toBe(true);
    expect(getRepoDir('t1')).not.toBe('/tmp/repo/repo');
  });
});
