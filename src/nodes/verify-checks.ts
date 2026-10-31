import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getVerifyLogDirFromDocs } from '../runtime/paths.js';
import { isLocalMode } from '../runtime/run-context.js';
import type { VerificationCheck } from '../state/types.js';

/**
 * The four deterministic gates of the verification stage.
 *
 * The order is fixed (`lint:ts` → `lint` → `test` → `e2e`).
 *
 * **The first two stop the pass when they fail**: a type error makes the
 * result of the other gates meaningless, and `eslint --fix` rewrites the
 * source code, so nothing may read it at the same time.
 *
 * **The last two run at the same time** (see `runGates`): they do not
 * rewrite the source code, and the e2e run is the slow one.
 *
 * The two of them still share the machine: a repository whose jest
 * `globalSetup` and whose Playwright `webServer` want the same port will
 * fail the e2e run for a reason that has nothing to do with the code.
 *
 * **Only `lint` carries `--fix`.** The other three gates report, they do not
 * repair: `tsc --noEmit` cannot write anything, and a test or an e2e run
 * that "fixed" itself would only hide the failure.
 *
 * **就地模式沒有 `--fix`**（見 {@link checkSpecFor}）：就地模式的 cwd 是
 * 使用者的業務倉庫，`--fix` 會**改寫使用者的原始碼**。克隆模式的那份副本
 * 是丟得掉的，自動修好沒有代價；就地模式有代價。
 */
export const VERIFY_CHECKS: ReadonlyArray<{
  name: VerificationCheck['name'];
  command: string[];
  fixable: boolean;
}> = [
  { name: 'lint:ts', command: ['npx', 'tsc', '--noEmit'], fixable: false },
  { name: 'lint', command: ['npx', 'eslint', '.', '--ext', '.ts,.tsx', '--fix'], fixable: true },
  { name: 'test', command: ['npx', 'jest', '--passWithNoTests', '--no-coverage'], fixable: false },
  { name: 'e2e', command: ['npx', 'playwright', 'test'], fixable: false },
];

/**
 * 這一次要跑的那道閘（依模式）。
 *
 * **就地模式不帶 `--fix`**：`--fix` 會改寫使用者的原始碼，而就地模式的
 * 工作目錄就是使用者的業務倉庫。閘門只**回報** lint 的問題，改不改由
 * 使用者決定（閘門的訊息會說明這件事）。
 *
 * **不帶 `--fix` 的閘門也不算 `fixable`**：它修不了自己，重跑一次只是
 * 把同一份錯誤再報一遍。
 *
 * @param name - 閘的名稱
 * @returns 這一輪實際要跑的規格；閘不存在時為 undefined
 */
export function checkSpecFor(
  name: VerificationCheck['name']
): { name: VerificationCheck['name']; command: string[]; fixable: boolean } | undefined {
  const spec = VERIFY_CHECKS.find((check) => check.name === name);
  if (!spec) return undefined;
  if (spec.name === 'lint' && isLocalMode()) {
    return {
      ...spec,
      command: spec.command.filter((arg) => arg !== '--fix'),
      fixable: false,
    };
  }
  return spec;
}

/** Default budget of a single gate. */
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

/**
 * Runs one command.
 *
 * The tests inject a fake runner instead of this one, so that a unit test
 * never runs `tsc`, `eslint`, `jest` or `playwright` for real.
 */
export type CheckRunner = (
  cmd: string[],
  cwd: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The result of one gate. */
export type CheckResult = {
  status: 'passed' | 'failed' | 'fixed';
  exitCode: number;
  /** The log of the gate - the same text that was written to the log file. */
  log: string;
};

/** Options of {@link runCheck}. */
export interface RunCheckOptions {
  /** Where the log of the gate is written (`<docsDir>/verify/<name>.log`). */
  docsDir: string;
  /** Budget of one attempt. Defaults to {@link DEFAULT_CHECK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The runner that executes the command. Defaults to {@link runCommand}. */
  runner?: CheckRunner;
}

/** One execution of a command. */
interface Attempt {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one gate and report what it did.
 *
 * A gate that fails is run a second time **only when it can fix itself**:
 * `eslint --fix` rewrites the files it complains about, so a second run
 * tells whether the complaint is gone (`fixed`) or real (`failed`).
 *
 * @param name - Which gate to run.
 * @param repoDir - The working directory of the command (the cloned repo).
 * @param opts - Where the log goes, the budget and the runner.
 * @throws Error when `name` is not one of the four gates.
 */
export async function runCheck(
  name: VerificationCheck['name'],
  repoDir: string,
  opts: RunCheckOptions
): Promise<CheckResult> {
  // **規格依模式**（就地模式的 lint 不帶 `--fix`）：見 {@link checkSpecFor}。
  const spec = checkSpecFor(name);
  if (!spec) {
    throw new Error(`unknown verification check: ${name}`);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const runner = opts.runner ?? ((cmd: string[], cwd: string) => runCommand(cmd, cwd, timeoutMs));

  const attempts: Attempt[] = [];
  attempts.push(await runner(spec.command, repoDir));

  let status: CheckResult['status'] = attempts[0].code === 0 ? 'passed' : 'failed';
  if (status === 'failed' && spec.fixable) {
    // The first run may have repaired the code - run it once more to find out.
    attempts.push(await runner(spec.command, repoDir));
    status = attempts[1].code === 0 ? 'fixed' : 'failed';
  }

  const last = attempts[attempts.length - 1];
  const log = buildLog(spec.command, attempts, status);
  writeLog(opts.docsDir, spec.name, log);

  return { status, exitCode: last.code, log };
}

/**
 * Run a command and collect its output.
 *
 * `spawn` instead of `execSync`: the graph must not block the event loop
 * while a gate runs, and a timeout has to be able to kill the child.
 *
 * A command that outlives its budget is killed and counted as a failure -
 * the log says `timeout`, so the reason for the failure is visible.
 *
 * @param cmd - The command and its arguments.
 * @param cwd - The working directory.
 * @param timeoutMs - The budget of the command.
 */
export function runCommand(
  cmd: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(bin, args, { cwd, detached: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          code: -1,
          stdout,
          stderr: `${stderr}\n[sdd-graph] timeout after ${timeoutMs}ms: ${cmd.join(' ')}`,
        });
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Kill a command and everything it spawned.
 *
 * The child runs in its own process group (`detached: true`), so the group
 * is what has to be killed: `npx` is only the launcher, and the `tsc` /
 * `jest` / `playwright` it started would keep running - and keep writing
 * into the repository - if only the launcher were killed.
 */
function killGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group is already gone (or was never created) - kill the child.
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing left to kill.
    }
  }
}

/** The text of the log of a gate. */
function buildLog(cmd: string[], attempts: Attempt[], status: CheckResult['status']): string {
  const lines: string[] = [`$ ${cmd.join(' ')}`];
  attempts.forEach((attempt, index) => {
    lines.push(`--- attempt ${index + 1} (exit ${attempt.code}) ---`);
    lines.push(`[stdout]`);
    lines.push(attempt.stdout.trimEnd());
    lines.push(`[stderr]`);
    lines.push(attempt.stderr.trimEnd());
  });
  lines.push(`[status] ${status}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The log file of a gate.
 *
 * The log lives next to the requirement documents (`<docsDir>/verify/`), so
 * it is committed together with the code it describes.
 */
export function checkLogPath(docsDir: string, name: string): string {
  return path.join(getVerifyLogDirFromDocs(docsDir), `${name}.log`);
}

/** Write the log of a gate. */
function writeLog(docsDir: string, name: string, log: string): void {
  const logFile = checkLogPath(docsDir, name);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, log, 'utf-8');
}
