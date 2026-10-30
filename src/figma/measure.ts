import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { FIGMA_PROTOTYPE_DIR, FIGMA_SCREENSHOT_DIR } from './paths.js';

/**
 * The measurements of the prototype against the Figma screenshots.
 *
 * Everything in this module is a pure function of files on disk: the same
 * inputs always produce the same report. The worker (the Claude Code
 * session) and the graph call the same code - the worker to iterate, the
 * graph to produce the authoritative report.
 */

/** A screenshot and the prototype page that has to look like it. */
export interface FramePair {
  /** The frame key: the node id of the Figma frame, `:` replaced by `-`. */
  key: string;
  /** The screenshot of the frame. */
  screenshot: string;
  /** The prototype page that has to look like the screenshot. */
  html: string;
}

/**
 * How a frame turned out.
 *
 * Everything but `ok` is a **hard failure**: the prototype cannot be compared
 * with the design at all. A frame that compares fine but differs a little is
 * `ok` with a ratio - the ratio is a hint, not a verdict.
 */
export type FrameStatus =
  | 'ok'
  | 'missing_html'
  | 'render_failed'
  | 'size_mismatch'
  | 'diff_failed';

/** The measurement of one frame. */
export interface FrameDiff {
  /** The frame key. */
  key: string;
  /** How the frame turned out. */
  status: FrameStatus;
  /** The share of pixels that differ (0..1). Zero when the frame failed. */
  ratio: number;
  /** The width of the screenshot. */
  width: number;
  /** The height of the screenshot. */
  height: number;
  /** Why it failed. */
  error?: string;
  /**
   * Whose problem the failure is.
   *
   * `environment` means the machine (no browser, no Playwright); the graph
   * has to ask a human about it. `page` means the prototype (broken markup,
   * a broken asset path); the worker can fix that.
   */
  errorKind?: 'environment' | 'page';
}

/**
 * Pair every screenshot with the prototype page of the same frame.
 *
 * The pairing is by file name: the screenshot `1-23.png` belongs to the page
 * `1-23.html`. A screenshot without a page is a frame the prototype does not
 * cover - the caller turns it into a hard failure.
 *
 * @param docsDir - The requirement directory of the run.
 * @returns The pairs and the keys whose page is missing.
 */
export function findFramePairs(docsDir: string): { pairs: FramePair[]; missingHtml: string[] } {
  const shotsDir = path.join(docsDir, FIGMA_SCREENSHOT_DIR);
  const prototypeDir = path.join(docsDir, FIGMA_PROTOTYPE_DIR);

  const keys = fs.existsSync(shotsDir)
    ? fs
        .readdirSync(shotsDir)
        .filter((name) => name.toLowerCase().endsWith('.png'))
        .map((name) => name.slice(0, -'.png'.length))
        .sort()
    : [];

  const pairs: FramePair[] = [];
  const missingHtml: string[] = [];
  for (const key of keys) {
    const html = path.join(prototypeDir, `${key}.html`);
    if (fs.existsSync(html)) {
      pairs.push({ key, screenshot: path.join(shotsDir, `${key}.png`), html });
    } else {
      missingHtml.push(key);
    }
  }

  return { pairs, missingHtml };
}

/**
 * Compare two PNG images pixel by pixel.
 *
 * Images of different sizes are **not** compared: a percentage of two
 * different pictures means nothing. The caller turns a size difference into
 * a hard failure instead.
 *
 * @param a - The reference image (the Figma screenshot).
 * @param b - The image to check (the rendered prototype).
 * @returns The share of pixels that differ and the diff image.
 */
export function comparePng(
  a: Buffer,
  b: Buffer
): { ratio: number; width: number; height: number; diff: Buffer } {
  const first = PNG.sync.read(a);
  const second = PNG.sync.read(b);
  const width = first.width;
  const height = first.height;

  if (second.width !== width || second.height !== height) {
    return { ratio: 0, width, height, diff: Buffer.alloc(0) };
  }

  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(first.data, second.data, diff.data, width, height, {
    threshold: 0.1,
  });

  return {
    ratio: mismatched / (width * height),
    width,
    height,
    diff: PNG.sync.write(diff),
  };
}

/**
 * The report of a measurement.
 *
 * The report says what the number means and what it does not mean: font and
 * anti-aliasing differences make the score unreliable, and a reader who does
 * not know that will read too much into it.
 *
 * @param frames - The measurement of every frame.
 * @returns The machine readable JSON and the human readable Markdown.
 */
export function buildReport(frames: FrameDiff[]): { json: string; md: string } {
  const json = JSON.stringify(frames, null, 2);

  const lines: string[] = [
    '# Figma 原型與截圖的 UI diff',
    '',
    '每一個 frame 一行。「不一致比例」是跟 Figma 截圖對不起來的像素佔全部像素的比例。',
    '',
    '**這個數字不是精確的視覺真值**：字體與抗鋸齒的差異會讓分數失真 —— 本機沒有設計檔',
    '用的字體時，文字區域會整片對不上，看起來像很大的差異，其實只是字型不同。',
    '把它當成「差很多」跟「差很少」的參考，不要當成 0.5% 這種精密度量。',
    '',
  ];

  if (frames.length === 0) {
    lines.push('沒有 frame：沒有截圖就沒有東西可比。');
  } else {
    lines.push('| frame | 狀態 | 不一致比例 | 尺寸 |');
    lines.push('| --- | --- | --- | --- |');
    for (const frame of frames) {
      lines.push(
        `| ${frame.key} | ${frame.status} | ${(frame.ratio * 100).toFixed(2)}% | ` +
          `${frame.width}x${frame.height} |`
      );
      // **The reason a frame failed is part of the report.** A worker that
      // has to fix the prototype needs the browser's own words, not the
      // word "render_failed".
      if (frame.error !== undefined && frame.error !== '') {
        lines.push(`| | ↳ ${frame.error} | | |`);
      }
    }
  }

  return { json, md: `${lines.join('\n')}\n` };
}
