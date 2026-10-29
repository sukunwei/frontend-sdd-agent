import { Command, END, START, StateGraph } from '@langchain/langgraph';
import type { CompiledGraph } from '@langchain/langgraph';
import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { bootstrapNode } from '../nodes/bootstrap.js';
import { e2eNode } from '../nodes/e2e-plan.js';
import { prdNode } from '../nodes/prd.js';
import { specNode } from '../nodes/spec.js';
import { taskSplitNode } from '../nodes/task-split.js';
import { getLockFilePath } from '../runtime/paths.js';
import { tddSubgraph } from '../subgraphs/tdd.js';
import { verifySubgraph } from '../subgraphs/verify.js';
import type { VerifyOptions } from '../subgraphs/verify.js';
import type { Stage } from '../state/types.js';
import {
  NODE_BOOTSTRAP,
  NODE_ENTRY_ROUTER,
  NODE_ROUTE_BY_STAGE,
  STAGE_NODE_NAMES,
} from './node-names.js';
import { SddStateAnnotation, toCommand } from './state.js';
import type { GraphState, NodeFn, NodeOutcome, NodeResult } from './state.js';

// The node names live in their own module: the stage nodes have to know the
// name of the node they route to (`Command({ goto })` takes a node name, not
// a stage name), and a name that lives in two places can only be right in
// one of them.
export { NODE_BOOTSTRAP, NODE_ENTRY_ROUTER, NODE_ROUTE_BY_STAGE, STAGE_NODE_NAMES } from './node-names.js';

/**
 * Decide where a run enters the graph.
 *
 * A run that has not been bootstrapped yet starts at `bootstrap`; every later
 * entry (a resume, a fresh session on an existing thread) goes straight to
 * the stage router. Without this node every resume would clone the
 * repository again.
 */
export async function entryRouter(state: GraphState): Promise<NodeOutcome> {
  return {
    kind: 'advance',
    update: {},
    goto: state.bootstrapped ? NODE_ROUTE_BY_STAGE : NODE_BOOTSTRAP,
  };
}

/**
 * Route to the node that owns the current stage.
 *
 * Only `currentStage` is read: the approvals and the blockers belong to the
 * stage nodes themselves.
 */
export async function routeByStage(state: GraphState): Promise<NodeOutcome> {
  return { kind: 'advance', update: {}, goto: stageTarget(state.currentStage) };
}

/**
 * Node a stage routes to.
 *
 * The bootstrap stage has no successor: `entry_router` sends a fresh run to
 * `bootstrap`, and the bootstrap node advances the stage to 'prd'. Routing
 * back to `bootstrap` would run the workspace setup a second time.
 */
function stageTarget(stage: Stage): string {
  if (stage === 'bootstrap') return END;
  return STAGE_NODE_NAMES[stage];
}

/** The run is over: the node ends the graph. */
const completedNode: NodeFn = async (): Promise<NodeOutcome> => ({
  kind: 'advance',
  update: { currentStage: 'completed' },
  goto: END,
});

/**
 * Adapt a node to the shape LangGraph expects.
 *
 * A node returns a routing outcome, which becomes a `Command`. A bare state
 * update is **refused**: no node of this graph has a static edge to fall back
 * on, so a bare update would end the run without a trace.
 */
function asNode(fn: NodeFn): (state: GraphState) => Promise<Command> {
  return async (state: GraphState): Promise<Command> => {
    const result = (await fn(state)) as NodeResult | Partial<GraphState>;
    if (!isNodeOutcome(result)) {
      throw new Error(
        'a node returned a state update instead of a routing outcome: every node ' +
          'has to return { kind: "advance", update, goto }'
      );
    }
    return toCommand(result);
  };
}

function isNodeOutcome(result: NodeResult | Partial<GraphState>): result is NodeOutcome {
  return typeof result === 'object' && result !== null && 'kind' in result;
}

/** Options of {@link buildGraph}. */
export interface BuildGraphOptions {
  /** Checkpointer that keeps the resume truth of the run. */
  checkpointer: SqliteSaver;
  /** Optional name of the compiled graph. */
  graphName?: string;
  /**
   * Branch lock file the bootstrap node uses.
   *
   * Defaults to the plugin-root lock. Tests point it at a temp file: the
   * lock is global, and flipping the real one would disturb whoever is
   * running sdd-graph right now.
   */
  lockPath?: string;
  /**
   * Nodes to replace, keyed by node name.
   *
   * Only names that exist in the graph may be used: a node nothing routes to
   * would make `compile()` fail with `UnreachableNodeError`. An unknown name
   * is therefore rejected loudly instead of being ignored.
   */
  testNodes?: Record<string, NodeFn>;
  /**
   * How the verification node runs its gates.
   *
   * The tests inject a fake runner this way, so that a unit test never runs
   * `tsc`, `eslint`, `jest` or `playwright` for real.
   */
  verifyOptions?: VerifyOptions;
}

/**
 * Every node name of the SDD graph.
 *
 * `CompiledGraph` is invariant in its node-name parameter, so the compiled
 * graph can only be typed with the exact union of node names.
 */
export type SddNodeName =
  | typeof NODE_ENTRY_ROUTER
  | typeof NODE_BOOTSTRAP
  | typeof NODE_ROUTE_BY_STAGE
  | (typeof STAGE_NODE_NAMES)[keyof typeof STAGE_NODE_NAMES]
  | typeof START
  | typeof END;

/**
 * The compiled SDD graph.
 *
 * `CompiledGraph` is invariant in its node-name union and in its stream
 * transformer tuple, so the node names are spelled out exactly; the
 * remaining type parameters describe internals of the compiled graph and are
 * left open.
 *
 * The output type is `GraphState | undefined`: `invoke()` returns `undefined`
 * when the last node wrote nothing, so the final state has to be read with
 * `getState()` - never from the return value of `invoke()`.
 */
export type CompiledSddGraph = CompiledGraph<
  SddNodeName,
  GraphState,
  any,
  Record<string, any>,
  any,
  GraphState | undefined,
  unknown,
  unknown,
  any,
  any
> & {
  /**
   * The branch lock file the bootstrap node of this graph works with.
   *
   * The CLI reads it back so that a reset releases the very same lock the
   * node took: an injected graph must not be released against another lock
   * file than the one it runs with.
   */
  lockPath: string;
};

/** Every node name the graph knows about. */
const KNOWN_NODE_NAMES: readonly string[] = [
  NODE_ENTRY_ROUTER,
  NODE_BOOTSTRAP,
  NODE_ROUTE_BY_STAGE,
  ...Object.values(STAGE_NODE_NAMES),
];

/**
 * Build the SDD graph.
 *
 * ```
 * START → entry_router ─┬→ bootstrap ─→ prd ─→ <stage node>
 *                        └→ routeByStage ─→ <stage node>
 * ```
 *
 * `entry_router` and `routeByStage` route with `Command({ goto })`, so every
 * node that can be a routing target has to be declared in the `ends` of the
 * node that routes to it — otherwise `compile()` throws
 * `UnreachableNodeError`.
 *
 * @throws Error when `testNodes` contains a node name the graph does not have.
 */
export function buildGraph(opts: BuildGraphOptions): CompiledSddGraph {
  const testNodes = opts.testNodes ?? {};

  const unknownNodes = Object.keys(testNodes).filter((name) => !KNOWN_NODE_NAMES.includes(name));
  if (unknownNodes.length > 0) {
    throw new Error(
      `unknown test node(s): ${unknownNodes.join(', ')}. ` +
        `Known nodes: ${KNOWN_NODE_NAMES.join(', ')}`
    );
  }

  // The real bootstrap node: it prepares the workspace, takes the branch
  // lock and clones the repository.
  const bootstrapFn: NodeFn = (state) => bootstrapNode(state, { lockPath: opts.lockPath });

  // The real PRD node: it asks the user for the requirements, maybe hands
  // out a Figma work order and asks for a confirmation.
  const prdFn: NodeFn = (state) => prdNode(state);

  // The real spec node: a host work order writes the spec, the node keeps
  // the gate (acceptance criteria, questions, blocking TBCs).
  const specFn: NodeFn = (state) => specNode(state);

  // The real e2e node: a host work order writes the plan, the node checks
  // that the plan has test cases.
  const e2eFn: NodeFn = (state) => e2eNode(state);

  // The real task-split node: a host work order writes the tasks, the node
  // keeps the gate (no L tasks, unique ids, coverage).
  const taskSplitFn: NodeFn = (state) => taskSplitNode(state);

  // The real TDD node: the tasks are worked one at a time, the developer and
  // the two reviewers get a work order each, and the node decides what the
  // next step is.
  const tddFn: NodeFn = (state) => tddSubgraph(state);

  // The real verification node: it runs the four deterministic gates and
  // asks the user what to do when one of them fails.
  const verifyFn: NodeFn = (state) => verifySubgraph(state, opts.verifyOptions);

  const graph = new StateGraph(SddStateAnnotation)
    .addNode(NODE_ENTRY_ROUTER, asNode(entryRouter), {
      ends: [NODE_BOOTSTRAP, NODE_ROUTE_BY_STAGE],
    })
    .addNode(NODE_BOOTSTRAP, asNode(testNodes[NODE_BOOTSTRAP] ?? bootstrapFn), {
      // The bootstrap node hands over to the PRD stage. It may also be sent
      // back to itself (a retry of the workspace setup).
      ends: [STAGE_NODE_NAMES.prd, NODE_BOOTSTRAP],
    })
    .addNode(NODE_ROUTE_BY_STAGE, asNode(routeByStage), {
      ends: [...Object.values(STAGE_NODE_NAMES), END],
    });

  // Every stage node declares the stages it may hand over to: a stage node
  // routes to the next stage and back into itself (it asks one question per
  // execution).
  const stageNodes: Array<[string, NodeFn, string[]]> = [
    [
      STAGE_NODE_NAMES.prd,
      prdFn,
      [STAGE_NODE_NAMES.prd, STAGE_NODE_NAMES.spec],
    ],
    [
      STAGE_NODE_NAMES.spec,
      specFn,
      [STAGE_NODE_NAMES.spec, STAGE_NODE_NAMES.e2ePlan, STAGE_NODE_NAMES.completed],
    ],
    [
      STAGE_NODE_NAMES.e2ePlan,
      e2eFn,
      [STAGE_NODE_NAMES.e2ePlan, STAGE_NODE_NAMES.taskSplit],
    ],
    [
      STAGE_NODE_NAMES.taskSplit,
      taskSplitFn,
      [STAGE_NODE_NAMES.taskSplit, STAGE_NODE_NAMES.tdd],
    ],
    // The TDD node works the tasks one at a time. It asks the session for
    // the implementation and for the two reviews (one interrupt per
    // execution), and it hands over to the verification stage when the last
    // task is done.
    [
      STAGE_NODE_NAMES.tdd,
      tddFn,
      [
        STAGE_NODE_NAMES.tdd,
        STAGE_NODE_NAMES.verification,
        STAGE_NODE_NAMES.completed,
      ],
    ],
    [STAGE_NODE_NAMES.completed, completedNode, [END]],
  ];
  for (const [name, fn, ends] of stageNodes) {
    graph.addNode(name, asNode(testNodes[name] ?? fn), { ends });
  }

  // The verification stage runs the four gates itself. It hands over to the
  // TDD stage (the user repairs the code by hand) or ends the run - and it
  // routes back into itself, because the gates run in their own execution
  // and their result is written to the state before anybody is asked
  // anything.
  graph.addNode(
    STAGE_NODE_NAMES.verification,
    asNode(testNodes[STAGE_NODE_NAMES.verification] ?? verifyFn),
    {
      ends: [
        STAGE_NODE_NAMES.verification,
        STAGE_NODE_NAMES.tdd,
        STAGE_NODE_NAMES.completed,
      ],
    }
  );

  const compiled = graph
    .addEdge(START, NODE_ENTRY_ROUTER)
    // The bootstrap node has **no** static edge: it routes itself with
    // `Command({ goto })`. A node that has a static edge to another node *and*
    // returns a `Command({ goto })` forks the run - both targets run, and the
    // node both of them lead to runs twice (the PRD stage would hand out two
    // work orders after a resume).
    .compile({ checkpointer: opts.checkpointer, name: opts.graphName });

  // Record the lock the bootstrap node works with, so that the CLI can
  // release the very same lock.
  return Object.assign(compiled, { lockPath: opts.lockPath ?? getLockFilePath() });
}
