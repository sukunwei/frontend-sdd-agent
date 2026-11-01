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
  getSddHome,
  getTaskDir,
  getRepoDir,
  getWorkspaceBase,
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
    expect(getSddHome()).toBe('/tmp/repo/.sdd');
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

  it('defaultSddHome 的衍生路徑一律是絕對路徑', () => {
    expect(defaultSddHome('.')).toBe(path.resolve('.sdd'));
    expect(path.isAbsolute(defaultSddHome('.'))).toBe(true);
  });

  it('local 模式下 task 與 repo 目錄必須留在 .sdd 之下（清理函式會遞迴刪除）', () => {
    setRunContext({ mode: 'local', repoRoot: '/tmp/repo', sddHome: '/tmp/repo/.sdd', workspaceBase: '/tmp/ws' });
    expect(getTaskDir('t1')).toBe('/tmp/repo/.sdd/tasks/t1');
    expect(getRepoDir('t1')).toBe('/tmp/repo/.sdd/tasks/t1/repo');
  });

  it('workspace base 與運行上下文無關（remote 語義固定在插件根）', () => {
    setRunContext({ mode: 'local', repoRoot: '/tmp/repo', sddHome: '/tmp/repo/.sdd', workspaceBase: '/tmp/ws' });
    expect(getWorkspaceBase()).toBe(`${getPluginRoot()}/workspace/tasks`);
  });
});
