import type { Stage } from '../state/types.js';

/**
 * The names of the nodes of the SDD graph.
 *
 * **A node routes with `Command({ goto })`, and LangGraph only accepts the
 * name of a node of the graph** - not the name of the stage in the state.
 * The two are close to each other (`e2ePlan` is the stage, `e2e_plan` is
 * the node), and a `goto` that names the stage instead of the node ends the
 * run without a trace. So the names live here, and both the graph and the
 * nodes import them: a rename cannot break one side only.
 */

/** Node name of the entry router. */
export const NODE_ENTRY_ROUTER = 'entry_router';

/** Node name of the bootstrap node. */
export const NODE_BOOTSTRAP = 'bootstrap';

/** Node name of the stage router. */
export const NODE_ROUTE_BY_STAGE = 'routeByStage';

/**
 * Node name of every stage `routeByStage` can route to.
 *
 * The stage nodes exist from the start: LangGraph only accepts a
 * `Command({ goto })` target that is a node of the graph, so a routing table
 * whose targets do not exist would silently end the run. A stage whose real
 * node has not landed yet is a placeholder.
 */
export const STAGE_NODE_NAMES = {
  prd: 'prd',
  spec: 'spec',
  e2ePlan: 'e2e_plan',
  taskSplit: 'task_split',
  tdd: 'tdd',
  // LangGraph refuses a node whose name collides with a state channel
  // ("verification is already being used as a state attribute"), and the
  // `verification` state field is fixed by the 1.1.0 schema. The node is
  // therefore called `verify` - the name the plan uses for the verification
  // subgraph (`src/subgraphs/verify.ts`).
  verification: 'verify',
  completed: 'completed',
} as const satisfies Record<Exclude<Stage, 'bootstrap'>, string>;
