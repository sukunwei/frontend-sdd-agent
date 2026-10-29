import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPluginRoot,
  getDocsDir,
  getRepoDir,
  getTaskDir,
  getVerifyLogDir,
  getWorkspaceBase,
  getLockFilePath,
  getCheckpointPath,
} from '../src/runtime/paths.js';

afterEach(() => {
  delete process.env.SDD_GRAPH_WORKSPACE_BASE;
});

describe('路徑解析', () => {
  it('插件根必須含 .claude-plugin/plugin.json', () => {
    expect(getPluginRoot().endsWith('/frontend-sdd-agent')).toBe(true);
    expect(fs.existsSync(path.join(getPluginRoot(), '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('docs 必須落在克隆的 repo 內，不是插件根', () => {
    const docs = getDocsDir('qrcode-app');
    expect(docs).toBe(`${getRepoDir('qrcode-app')}/docs/qrcode-app`);
    expect(docs.startsWith(getPluginRoot() + '/docs')).toBe(false);
  });

  it('workspace base 預設固定在插件根下', () => {
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    expect(getWorkspaceBase()).toBe(`${getPluginRoot()}/workspace/tasks`);
  });

  it('SDD_GRAPH_WORKSPACE_BASE 可覆寫 workspace base（測試用）', () => {
    process.env.SDD_GRAPH_WORKSPACE_BASE = '/tmp/sdd-ws';
    expect(getWorkspaceBase()).toBe('/tmp/sdd-ws');
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
  });

  it('SDD_GRAPH_WORKSPACE_BASE 為相對路徑時仍回傳絕對路徑', () => {
    process.env.SDD_GRAPH_WORKSPACE_BASE = './tmp/sdd-ws';
    const base = getWorkspaceBase();
    expect(path.isAbsolute(base)).toBe(true);
    expect(base).toBe(path.resolve('./tmp/sdd-ws'));
    // 衍生路徑也必須是絕對路徑（工作單 inputs/outputs 一律絕對路徑）
    expect(path.isAbsolute(getTaskDir('qrcode-app'))).toBe(true);
    expect(path.isAbsolute(getRepoDir('qrcode-app'))).toBe(true);
    expect(path.isAbsolute(getDocsDir('qrcode-app'))).toBe(true);
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
  });

  it('task 目錄與 repo 目錄都在 workspace base 之下', () => {
    expect(getTaskDir('qrcode-app')).toBe(`${getWorkspaceBase()}/qrcode-app`);
    expect(getRepoDir('qrcode-app')).toBe(`${getWorkspaceBase()}/qrcode-app/repo`);
  });

  it('verify log 落在 docs 之下', () => {
    expect(getVerifyLogDir('qrcode-app')).toBe(`${getDocsDir('qrcode-app')}/verify`);
  });

  it('lock 與 checkpoint 固定在插件根的 runtime 目錄', () => {
    expect(getLockFilePath()).toBe(`${getPluginRoot()}/runtime/branch-runtime-lock.json`);
    expect(getCheckpointPath()).toBe(`${getPluginRoot()}/runtime/checkpoints.sqlite`);
  });

  it('可指定外部 repo 目錄（測試 fixture 用）', () => {
    expect(getDocsDir('qrcode-app', '/tmp/fixture-repo')).toBe(
      '/tmp/fixture-repo/docs/qrcode-app'
    );
    expect(getVerifyLogDir('qrcode-app', '/tmp/fixture-repo')).toBe(
      '/tmp/fixture-repo/docs/qrcode-app/verify'
    );
  });
});
