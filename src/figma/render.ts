import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PNG } from 'pngjs';

/**
 * Rendering a prototype page into a picture.
 *
 * The renderer uses the **Playwright of the target repository**: the
 * verification stage already runs `npx playwright test` there, so the
 * browser is already there and the plugin does not have to ship one.
 *
 * **The command is the repository's own binary**, `<repo>/node_modules/.bin/
 * playwright` - not `npx`. `npx` downloads a package that is not there
 * (from the network, into the user's cache), and the thing it downloads is
 * not the version the repository pinned; with a cached Playwright whose
 * browsers are not installed it even waits for a download to start. The
 * binary of the repository cannot do either: it is either there or it is
 * not, and "not" is reported without running anything.
 *
 * **A failure is classified.** A missing browser is the machine's problem;
 * broken markup is the prototype's. The caller sends the first one to a
 * human and the second one back to the worker, so the classification has
 * to be right.
 */

/** What to render, and where to put the result. */
export interface RenderRequest {
  /** The prototype page (an absolute path). */
  html: string;
  /** Where the picture goes (an absolute path). */
  out: string;
  /** The width of the viewport. */
  width: number;
  /** The height of the viewport. */
  height: number;
  /** The working directory of the command (the target repository). */
  cwd: string;
}

/**
 * The outcome of a rendering.
 *
 * `kind` tells the caller **whose problem it is**: `environment` is the
 * machine (no browser, no Playwright), `page` is the prototype (broken
 * markup, a broken asset path). The graph sends the first one to a human
 * and the second one back to the worker.
 */
export interface RenderResult {
  /** Did the picture appear? */
  ok: boolean;
  /** Why it did not. */
  error?: string;
  /** Whose problem it is. */
  kind?: 'environment' | 'page';
}

/** Renders a page into a picture. */
export type RenderRunner = (req: RenderRequest) => Promise<RenderResult>;

/** The options of a spawned process. */
export interface SpawnOptions {
  cwd: string;
  /** Run the child in its own process group (so the group can be killed). */
  detached?: boolean;
}

/**
 * The part of a child process the renderer uses.
 *
 * The real `child_process.spawn` fits this shape; so does a fake in a test.
 */
export interface ChildProcessLike {
  stderr: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  /** Kills the child (the renderer uses it when the budget is over). */
  kill?(): boolean;
}

/** Starts a process. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcessLike;

/** How long a rendering may take. */
export const DEFAULT_RENDER_TIMEOUT_MS = 60_000;

/**
 * What Playwright says when the **browser** is not installed.
 *
 * The message is Playwright's, not ours: it is the only way to tell a
 * machine without a browser from a page that does not render.
 */
const BROWSER_MISSING =
  /executable doesn't exist|please run the following command to download new browsers/i;

/** The Playwright of a repository, if it has one. */
export function playwrightBinary(cwd: string): string | undefined {
  const binary = path.join(cwd, 'node_modules', '.bin', 'playwright');
  return fs.existsSync(binary) ? binary : undefined;
}

/** What a person has to do when the browser is missing. */
const PLAYWRIGHT_HINT =
  'the target repository needs Playwright (npm i -D playwright && npx playwright install chromium)';

/**
 * Render a page with the Playwright of the target repository.
 *
 * The page is loaded from a `file://` url: the prototype is a static page
 * with relative paths, and it must render the same way on every machine.
 *
 * @param options - The process to use and the budget. The default is the
 *   real `spawn`; the tests inject a fake so that no browser is ever
 *   started.
 * @returns A runner that never throws: a failure is a result, not an
 *   exception, because the caller has to write it into the report.
 */
export function playwrightRunner(
  options: {
    spawn?: SpawnFn;
    timeoutMs?: number;
    resolvePlaywright?: (cwd: string) => string | undefined;
  } = {}
): RenderRunner {
  const start = options.spawn ?? (spawn as unknown as SpawnFn);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const resolve = options.resolvePlaywright ?? playwrightBinary;

  return async (req: RenderRequest): Promise<RenderResult> => {
    const binary = resolve(req.cwd);
    if (binary === undefined) {
      // **The machine has no Playwright.** Nothing is run: the report says
      // so straight away, and the graph asks a human instead of sending
      // the worker to fix an HTML page that is already fine.
      return {
        ok: false,
        kind: 'environment',
        error: `no Playwright in ${req.cwd} — ${PLAYWRIGHT_HINT}`,
      };
    }

    return new Promise<RenderResult>((resolveResult) => {
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: RenderResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolveResult(result);
      };

      let child: ChildProcessLike;
      try {
        child = start(
          binary,
          [
            'screenshot',
            `--viewport-size=${req.width},${req.height}`,
            pathToFileURL(req.html).href,
            req.out,
          ],
          { cwd: req.cwd, detached: true }
        );
      } catch (err) {
        finish({
          ok: false,
          kind: 'environment',
          error: `cannot run playwright: ${messageOf(err)}`,
        });
        return;
      }

      // **The budget.** A browser that hangs must not hang the run.
      timer = setTimeout(() => {
        killGroup(child);
        finish({
          ok: false,
          kind: 'environment',
          error: `playwright screenshot timeout after ${timeoutMs}ms — ${PLAYWRIGHT_HINT}`,
        });
      }, timeoutMs);

      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        finish({
          ok: false,
          kind: 'environment',
          error: `cannot run playwright: ${messageOf(error)}`,
        });
      });
      child.on('close', (code) => {
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const detail = stderr.trim();
        // **Whose fault is it?** A browser that is not installed is the
        // machine's problem; everything else is the page's.
        const kind = BROWSER_MISSING.test(detail) ? 'environment' : 'page';
        finish({
          ok: false,
          kind,
          error:
            `playwright screenshot failed (code ${code})` +
            (detail === '' ? '' : `: ${detail}`) +
            (kind === 'environment' ? ` — ${PLAYWRIGHT_HINT}` : ''),
        });
      });
    });
  };
}

/**
 * Kill a child and everything it spawned.
 *
 * The child runs in its own process group (`detached: true`), so the group
 * is what has to be killed: the Playwright binary starts a browser, and
 * killing only the wrapper would leave the browser running.
 *
 * @param child - The child to kill.
 */
function killGroup(child: ChildProcessLike): void {
  child.kill?.();
}

/**
 * The size of a PNG file.
 *
 * @param file - The picture (an absolute path).
 * @returns Its width and height.
 * @throws Error when the file cannot be read or is not a PNG.
 */
export function pngSize(file: string): { width: number; height: number } {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cannot read the png "${file}": ${messageOf(err)}`);
  }
  try {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height };
  } catch (err) {
    throw new Error(`"${file}" is not a png: ${messageOf(err)}`);
  }
}

/** The message of an error. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
