import { readPrompt } from '../runtime/paths.js';

/**
 * The bodies of the work orders.
 *
 * A work order is a template: the graph knows what the order is about (the
 * goal, the working directory, the files to read, the files to write), and
 * the template tells the worker what to do with them. `renderPrompt` puts the
 * two together.
 *
 * **The variables of a template are exactly the variables it uses.** A
 * template that asks for a variable nobody gives is a work order with a hole
 * in it; a variable that nobody asks for is a value that was computed and
 * thrown away. Both are errors: the loader refuses to render a half-finished
 * work order.
 */

/** `{{name}}` - a template variable. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Any `{{ ... }}` in a template - a variable, or a typo that looks like one.
 *
 * The strict pattern above only matches names it can substitute. A template
 * with `{{goal-title}}` in it would leave that text in the rendered work
 * order, where the worker reads it as part of the order. This pattern finds
 * those holes so the loader can refuse to render them.
 */
const BRACE_PATTERN = /\{\{[\s\S]*?\}\}/g;

/** The name of a role: the file name of the prompt, without the extension. */
const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The variables a work order carries.
 *
 * The order of the fields is the order of the sections of the template.
 */
export interface WorkOrderVars {
  /** What this order is about. */
  goal: string;
  /** The working directory of the order (the cloned repository). */
  cwd: string;
  /** The absolute paths the worker has to read. */
  inputs: string[];
  /** The absolute paths the worker has to write. */
  outputs: string[];
  /** What the outputs have to look like. */
  outputFormat: string;
}

/**
 * Where the loader reads the prompt files from.
 *
 * The tests point this at a temp dir: a test that writes a broken template
 * must not leave it behind in the directory the plugin ships - a leftover
 * `prompts/zz-something.md` is a work order that the plugin would hand out.
 */
export interface PromptOptions {
  /** The directory that holds the prompt files. Defaults to the plugin root. */
  promptsDir?: string;
}

/**
 * Render the body of a work order.
 *
 * @param role - The role of the order (`spec-writer`, `developer`, ...).
 * @param vars - The variables of the template.
 * @param opts - Where the template comes from.
 * @throws Error when the role is unknown, when the template has a malformed
 *   placeholder, when a variable of the template is missing, or when a
 *   variable is given that the template does not use.
 */
export function renderPrompt(
  role: string,
  vars: Record<string, string>,
  opts: PromptOptions = {}
): string {
  const template = readTemplate(role, opts);
  const malformed = malformedPlaceholder(template);
  if (malformed !== undefined) {
    throw new Error(
      `the work order "${role}" has a malformed placeholder (${malformed}): ` +
        'a placeholder is "{{name}}" with a plain name - a rendered work order ' +
        'must not contain a hole'
    );
  }

  const required = variablesOf(template);

  const missing = required.filter((name) => typeof vars[name] !== 'string');
  if (missing.length > 0) {
    throw new Error(
      `the work order "${role}" needs the variable(s) ${missing.join(', ')}, ` +
        'and none of them may be left out'
    );
  }

  const unknown = Object.keys(vars).filter((name) => !required.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `the work order "${role}" does not use the variable(s) ${unknown.join(', ')}: ` +
        'the template and the caller disagree about the order'
    );
  }

  // **The template was checked for holes, so nothing is left to find here.**
  // A `{{` in the *rendered* text can only come from a value - the title of
  // a task, for instance. That is not a hole: refusing to render it would
  // kill the run over a task that mentions a template in its title.
  return template.replace(VARIABLE_PATTERN, (_match, name: string) => vars[name]);
}

/**
 * The placeholder of a template that is not a variable, if there is one.
 *
 * A template that says `{{goal-title}}` has a hole: the strict variable
 * pattern does not match it, so it would survive the substitution and the
 * worker would read the text as part of the order. An unclosed `{{` is the
 * same kind of hole.
 *
 * @param template - The body of the template.
 * @returns The offending text, or `undefined` when every placeholder is a
 *   variable.
 */
function malformedPlaceholder(template: string): string | undefined {
  // Whatever is left after the real placeholders are taken out must not look
  // like a placeholder any more - that is an unclosed one.
  const rest = template.replace(BRACE_PATTERN, '');
  const open = rest.indexOf('{{');
  if (open !== -1) {
    return rest.slice(open, open + 40);
  }
  for (const match of template.matchAll(BRACE_PATTERN)) {
    if (!/^\{\{\s*[A-Za-z0-9_]+\s*\}\}$/.test(match[0])) {
      return match[0];
    }
  }
  return undefined;
}

/**
 * The variables of the body of a work order.
 *
 * @param role - The role of the order.
 * @param opts - Where the template comes from.
 * @throws Error when the role is unknown, its body cannot be read, or it has
 *   a malformed placeholder.
 */
export function promptVariables(role: string, opts: PromptOptions = {}): string[] {
  const template = readTemplate(role, opts);
  const malformed = malformedPlaceholder(template);
  if (malformed !== undefined) {
    throw new Error(
      `the work order "${role}" has a malformed placeholder (${malformed}): ` +
        'a placeholder is "{{name}}" with a plain name'
    );
  }
  return variablesOf(template);
}

/**
 * Render the body of a work order from the values of the order.
 *
 * The paths become a list the worker can read: an order names absolute
 * paths, and a session that resumes in another conversation re-reads them
 * from disk alone.
 *
 * @param role - The role of the order.
 * @param vars - The values of the order.
 * @param opts - Where the template comes from.
 * @throws Error when the template and the values do not fit together.
 */
export function renderWorkOrder(
  role: string,
  vars: WorkOrderVars,
  opts: PromptOptions = {}
): string {
  return renderPrompt(
    role,
    {
      goal: vars.goal,
      cwd: vars.cwd,
      inputs: bulletList(vars.inputs),
      outputs: bulletList(vars.outputs),
      outputFormat: vars.outputFormat,
    },
    opts
  );
}

/**
 * Read the template of a role.
 *
 * @throws Error when the role is not a plain name, or when the file cannot
 *   be read - a work order without a body cannot be worked.
 */
function readTemplate(role: string, opts: PromptOptions): string {
  if (!ROLE_PATTERN.test(role)) {
    throw new Error(`"${role}" is not a work order role (expected a plain name, e.g. spec-writer)`);
  }
  return readPrompt(role, opts.promptsDir);
}

/**
 * The variables a template uses, in the order they appear.
 *
 * @param template - The body of the template.
 */
function variablesOf(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * A list of paths, one per line.
 *
 * @param files - The paths of the list.
 */
function bulletList(files: string[]): string {
  if (files.length === 0) return '（無）';
  return files.map((file) => `- ${file}`).join('\n');
}
