import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../src/persistence/artifact-store.js';
import { getDocsDir } from '../src/runtime/paths.js';

const REQUIREMENT = 'qrcode-app';

describe('ArtifactStore', () => {
  let originalWorkspaceBase: string | undefined;
  let workspaceBase: string;

  beforeEach(() => {
    // ArtifactStore 會真的寫檔，必須指向一次性暫存目錄，不得寫進插件根目錄
    originalWorkspaceBase = process.env.SDD_GRAPH_WORKSPACE_BASE;
    workspaceBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-graph-artifact-'));
    process.env.SDD_GRAPH_WORKSPACE_BASE = workspaceBase;
  });

  afterEach(() => {
    if (originalWorkspaceBase === undefined) {
      delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    } else {
      process.env.SDD_GRAPH_WORKSPACE_BASE = originalWorkspaceBase;
    }
    fs.rmSync(workspaceBase, { recursive: true, force: true });
  });

  it('state 與 workflow-state.json 雙向一致', () => {
    const store = new ArtifactStore(REQUIREMENT);
    const state = { version: '1.1.0', requirementName: REQUIREMENT, currentStage: 'spec', tasks: [], tbcItems: [], blockers: [], approvals: {}, artifacts: {}, verification: { checks: [] } } as any;
    store.sync(state);
    const onDisk = JSON.parse(fs.readFileSync(path.join(getDocsDir(REQUIREMENT), 'workflow-state.json'), 'utf-8'));
    expect(onDisk.currentStage).toBe('spec');
    expect(onDisk.version).toBe('1.1.0');
    expect(store.load()?.currentStage).toBe('spec');
  });

  it('寫入是原子的（temp + rename），不會留半檔', () => {
    const store = new ArtifactStore(REQUIREMENT);
    store.sync({ currentStage: 'prd' } as any);
    const dir = getDocsDir(REQUIREMENT);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('鏡像覆蓋宿主擅自改寫的內容', () => {
    const store = new ArtifactStore(REQUIREMENT);
    store.sync({ currentStage: 'prd' } as any);
    const p = path.join(getDocsDir(REQUIREMENT), 'workflow-state.json');
    fs.writeFileSync(p, JSON.stringify({ currentStage: 'completed' }));
    store.sync({ currentStage: 'spec' } as any);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).currentStage).toBe('spec');
  });

  it('鏡像寫在 repo 的 docs 目錄下，且不存在時 load 回 null', () => {
    const store = new ArtifactStore(REQUIREMENT);
    expect(store.statePath).toBe(path.join(getDocsDir(REQUIREMENT), 'workflow-state.json'));
    expect(store.timelinePath).toBe(path.join(getDocsDir(REQUIREMENT), 'timeline.md'));
    expect(store.load()).toBeNull();
  });

  it('timeline 逐行追加並帶時間戳', () => {
    const store = new ArtifactStore(REQUIREMENT);
    store.appendTimeline('stage → prd');
    store.appendTimeline('stage → spec');
    const lines = fs.readFileSync(store.timelinePath, 'utf-8').trim().split('\n');
    const entries = lines.filter((line) => line.startsWith('- ['));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('stage → prd');
    expect(entries[1]).toContain('stage → spec');
    expect(entries[0]).toMatch(/^- \[\d{4}-\d{2}-\d{2}T/);
  });
});
