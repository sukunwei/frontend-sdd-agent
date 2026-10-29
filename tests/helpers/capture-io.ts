import { vi } from 'vitest';

/** What the CLI wrote since the last {@link IoCapture.take}. */
export interface CapturedIo {
  out: string;
  err: string;
}

/** A stdout/stderr capture. */
export interface IoCapture {
  /** Returns what was written since the last call and clears the buffer. */
  take: () => CapturedIo;
  /** Stops capturing (and lets the real stdout work again). */
  restore: () => void;
}

/**
 * Capture what the CLI writes to stdout/stderr.
 *
 * The capture is installed for a whole describe block, so no envelope ever
 * leaks into the test output; `take()` returns what was written since the
 * last call.
 */
export function captureIo(): IoCapture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  });
  return {
    take: () => {
      const captured = { out: outChunks.join(''), err: errChunks.join('') };
      outChunks.length = 0;
      errChunks.length = 0;
      return captured;
    },
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}
