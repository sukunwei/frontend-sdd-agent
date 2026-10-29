import { interrupt } from '@langchain/langgraph';
import { buildGraph } from '../../src/graph/compile.js';
import type { CompiledSddGraph } from '../../src/graph/compile.js';
import type { NodeOutcome } from '../../src/graph/state.js';
import { createCheckpointer } from '../../src/persistence/checkpoint.js';

/** Knobs of the work order the fixture graph issues. */
export interface HostGraphOptions {
  /** Role of the work order. */
  role?: string;
  /** Prompt of the work order. */
  prompt?: string;
  /** Working directory of the work order. */
  cwd?: string;
  /** Absolute paths the worker has to read. */
  inputs?: string[];
  /** Absolute paths the worker has to write. */
  outputs?: string[];
  /** Which result the order expects back. */
  resultSchema?: 'review' | 'none';
}

/** The fixture graph plus the counters the tests assert on. */
export interface HostGraph {
  graph: CompiledSddGraph;
  /** How often the last node of the chain ran (proves the graph advanced). */
  runs: { tail: number };
}

/**
 * A graph whose `prd` node issues one host work order and then walks the
 * remaining stages to `completed`.
 */
export function buildHostGraph(dbPath: string, opts: HostGraphOptions = {}): HostGraph {
  const saver = createCheckpointer(dbPath);
  const runs = { tail: 0 };
  const graph = buildGraph({
    checkpointer: saver,
    testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance',
        update: { bootstrapped: true, currentStage: 'prd' },
        goto: 'prd',
      }),
      prd: async (): Promise<NodeOutcome> => {
        interrupt({
          audience: 'host',
          type: 'work_order',
          role: opts.role ?? 'spec_writer',
          prompt: opts.prompt ?? 'write the spec',
          cwd: opts.cwd ?? '/repo',
          inputs: opts.inputs ?? [],
          outputs: opts.outputs ?? [],
          resultSchema: opts.resultSchema ?? 'none',
        });
        return { kind: 'advance', update: {}, goto: 'spec' };
      },
      spec: async () => ({ kind: 'advance', update: {}, goto: 'e2e_plan' }),
      e2e_plan: async () => ({ kind: 'advance', update: {}, goto: 'task_split' }),
      task_split: async () => ({ kind: 'advance', update: {}, goto: 'tdd' }),
      tdd: async () => ({ kind: 'advance', update: {}, goto: 'verify' }),
      verify: async () => {
        runs.tail += 1;
        return { kind: 'advance', update: { currentStage: 'completed' }, goto: 'completed' };
      },
    },
  });
  return { graph, runs };
}
