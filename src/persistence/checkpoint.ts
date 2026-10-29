import * as fs from 'fs';
import * as path from 'path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

/**
 * Create the SQLite checkpointer that holds the resume truth of every run.
 *
 * The parent directory is created when it is missing: the default location
 * (`<plugin-root>/runtime/checkpoints.sqlite`) lives in a directory nothing
 * else creates, and a missing directory would otherwise turn the first
 * `resume` into an opaque SQLite error.
 */
export function createCheckpointer(dbPath: string): SqliteSaver {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return SqliteSaver.fromConnString(dbPath);
}
