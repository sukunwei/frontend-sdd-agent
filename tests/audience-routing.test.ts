import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerResultSchema, WorkOrderSchema } from '../src/cli/protocol.js';
import { runCli } from '../src/cli/index.js';
import { captureIo } from './helpers/capture-io.js';
import { buildHostGraph } from './helpers/host-graph.js';

describe('audience 路由', () => {
  it('host 工作單必須帶 audience=host 與絕對路徑 outputs', () => {
    const ok = WorkOrderSchema.safeParse({ audience: 'host', role: 'spec_writer', prompt: 'p', cwd: '/a', inputs: ['/a/spec.md'], outputs: ['/a/out/spec.md'], resultSchema: 'none' });
    expect(ok.success).toBe(true);
  });

  it('缺少 audience 的工作單一律不合法', () => {
    expect(WorkOrderSchema.safeParse({ role: 'spec_writer', prompt: 'p', cwd: '/a', inputs: [], outputs: [] }).success).toBe(false);
  });

  it('評審結果不是合法 JSON 結構時，zod 解析失敗', () => {
    expect(WorkerResultSchema.safeParse({ status: 'ok', summary: 'PASS', changedFiles: [] }).success).toBe(true);
    expect(WorkerResultSchema.safeParse({ status: 'ok', summary: 'PASS', changedFiles: [], review: { role: 'spec', verdict: 'pass' } }).success).toBe(false);
  });

  it('audience 不得是 host 以外的值', () => {
    expect(WorkOrderSchema.safeParse({ audience: 'user', role: 'spec_writer', prompt: 'p', cwd: '/a', inputs: [], outputs: [] }).success).toBe(false);
  });

  it('工作單的 inputs/outputs 必須是絕對路徑', () => {
    const relative = { audience: 'host', role: 'spec_writer', prompt: 'p', cwd: '/a', inputs: [], outputs: [] };
    expect(WorkOrderSchema.safeParse({ ...relative, outputs: ['out/spec.md'] }).success).toBe(false);
    expect(WorkOrderSchema.safeParse({ ...relative, inputs: ['docs/spec.md'] }).success).toBe(false);
    expect(WorkOrderSchema.safeParse({ ...relative, outputs: ['/a/out/spec.md'] }).success).toBe(true);
  });
});

describe('audience 路由（CLI）', () => {
  let dir: string;
  let db: string;
  let lockFile: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-aud-'));
    db = path.join(dir, 'cp.sqlite');
    lockFile = path.join(dir, 'branch-runtime-lock.json');
    // 預設圖用的是正式的 bootstrap 節點：工作區與鎖都必須落在暫存目錄
    process.env.SDD_GRAPH_WORKSPACE_BASE = dir;
    io = captureIo();
  });
  afterEach(() => {
    io.restore();
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('user 閘口不得被 complete 推進', async () => {
    // 預設圖的 bootstrap 節點會以 audience=user 中斷
    const rc1 = await runCli(['start', '--task', 'aud-user', '--repo', 'file:///nonexistent'], { checkpointPath: db, lockPath: lockFile });
    io.take();
    expect(rc1).toBe(2);

    const rc2 = await runCli(['complete', '--task', 'aud-user', '--result', JSON.stringify({ status: 'ok', summary: '', changedFiles: [] })], { checkpointPath: db });
    const captured = io.take();
    expect(rc2).toBe(1);
    const err = JSON.parse(captured.err);
    expect(err.kind).toBe('error');
    expect(err.code).toBe('audience_mismatch');
  });

  it('host 工作單不得被 approve 推進', async () => {
    const { graph } = buildHostGraph(db);
    const rc1 = await runCli(['start', '--task', 'aud-host', '--repo', 'file:///nonexistent'], { graph });
    io.take();
    expect(rc1).toBe(2);

    const rc2 = await runCli(['approve', '--task', 'aud-host', '--payload', JSON.stringify({ approved: true })], { graph });
    const captured = io.take();
    expect(rc2).toBe(1);
    const err = JSON.parse(captured.err);
    expect(err.kind).toBe('error');
    expect(err.code).toBe('audience_mismatch');
  });

  it('user 閘口可以用 approve 推進', async () => {
    const rc1 = await runCli(['start', '--task', 'aud-approve', '--repo', 'file:///nonexistent'], { checkpointPath: db, lockPath: lockFile });
    io.take();
    expect(rc1).toBe(2);

    const rc2 = await runCli(['approve', '--task', 'aud-approve', '--payload', JSON.stringify({ approved: true })], { checkpointPath: db, lockPath: lockFile });
    const captured = io.take();
    // 推進之後圖繼續走，停在下一個 user 閘口 → 仍然是 exit 2，但不是錯誤
    expect(rc2).toBe(2);
    expect(captured.err).toBe('');
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.audience).toBe('user');
  });
});
