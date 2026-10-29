import { interrupt } from '@langchain/langgraph';
import { buildGraph } from '../../src/graph/compile.js';
import type { CompiledSddGraph } from '../../src/graph/compile.js';
import type { NodeOutcome } from '../../src/graph/state.js';
import type { CheckRunner } from '../../src/nodes/verify-checks.js';
import { createCheckpointer } from '../../src/persistence/checkpoint.js';

/** Options of {@link buildVerifyGraph}. */
export interface VerifyGraphOptions {
  /** Checkpoint database of the run. */
  dbPath: string;
  /** The repository the gates run in. */
  repoDir: string;
  /** The requirement name (the logs live under its docs directory). */
  requirementName?: string;
  /** The runner the gates use - the tests inject a fake one. */
  runner: CheckRunner;
  /**
   * Stop the run at the TDD stage instead of walking back to the gates.
   *
   * The run parks on a work order there, so a test can count what the
   * verification stage did without a second pass muddying the count.
   */
  tddParks?: boolean;
}

/** The counters the assertions read. */
export interface VerifyGraphRuns {
  /**
   * How often the TDD stage ran *after* the verification gate.
   *
   * The pipeline walks through the TDD stage on its way to the verification
   * stage as well; only the run the gate routes back to counts.
   */
  tdd: number;
}

/** The parts of a snapshot the assertions read. */
export interface VerifySnapshot {
  values: Record<string, unknown>;
  tasks: Array<{ interrupts?: Array<{ value: unknown }> }>;
  next: string[];
}

/**
 * A graph that walks straight to the verification stage.
 *
 * The stages in front of the verification stage are stubs: the tests are
 * about the gate, not about the pipeline.
 */
export function buildVerifyGraph(opts: VerifyGraphOptions): {
  graph: CompiledSddGraph;
  runs: VerifyGraphRuns;
} {
  const runs: VerifyGraphRuns = { tdd: 0 };

  const graph = buildGraph({
    checkpointer: createCheckpointer(opts.dbPath),
    verifyOptions: { runner: opts.runner },
    testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance',
        update: {
          bootstrapped: true,
          currentStage: 'prd',
          requirementName: opts.requirementName ?? 'demo',
          repoPath: opts.repoDir,
        },
        goto: 'prd',
      }),
      prd: async (): Promise<NodeOutcome> => ({ kind: 'advance', update: {}, goto: 'spec' }),
      spec: async (): Promise<NodeOutcome> => ({ kind: 'advance', update: {}, goto: 'e2e_plan' }),
      e2e_plan: async (): Promise<NodeOutcome> => ({ kind: 'advance', update: {}, goto: 'task_split' }),
      task_split: async (): Promise<NodeOutcome> => ({ kind: 'advance', update: {}, goto: 'tdd' }),
      tdd: async (state): Promise<NodeOutcome> => {
        // The verification node sets `currentStage` to 'tdd' when it routes
        // back - that is the run this counter is about.
        if (state.currentStage === 'tdd') {
          runs.tdd += 1;
          if (opts.tddParks) {
            interrupt({
              audience: 'host',
              type: 'work_order',
              role: 'developer',
              prompt: 'repair the code by hand',
              cwd: opts.repoDir,
              inputs: [],
              outputs: [],
            });
          }
        }
        return { kind: 'advance', update: {}, goto: 'verify' };
      },
    },
  });

  return { graph, runs };
}

/** The state of a thread, as the assertions read it. */
export async function readSnapshot(
  graph: CompiledSddGraph,
  cfg: { configurable: { thread_id: string } }
): Promise<VerifySnapshot> {
  return (await graph.getState(cfg)) as unknown as VerifySnapshot;
}
