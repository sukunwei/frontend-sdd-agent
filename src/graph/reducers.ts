import type { Blocker, VerificationCheck } from '../state/types.js';

/**
 * The verification section of the workflow state.
 *
 * `SddState` declares it inline (`{ checks: VerificationCheck[] }`); the
 * reducer needs a name for it, so it is declared here and kept structurally
 * identical to the interface.
 */
export interface VerificationState {
  checks: VerificationCheck[];
}

/**
 * Merge two lists by a key.
 *
 * An item on the right replaces the item with the same key **in place**, so
 * the order of the left list is preserved; an item with a new key is appended.
 */
function mergeByKey<T>(left: T[], right: T[], key: (item: T) => string): T[] {
  const merged = [...(left ?? [])];
  for (const item of right ?? []) {
    const index = merged.findIndex((existing) => key(existing) === key(item));
    if (index === -1) merged.push(item);
    else merged[index] = item;
  }
  return merged;
}

/**
 * Merge two lists of identified items: the right side wins on a shared `id`,
 * new ids are appended.
 */
export function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  return mergeByKey(left, right, (item) => item.id);
}

/** Shallow-merge two records; the right side wins on a shared key. */
export function mergeRecord<T>(left: Record<string, T>, right: Record<string, T>): Record<string, T> {
  return { ...left, ...right };
}

/**
 * Merge two lists of blockers.
 *
 * **A resolved blocker is dropped.** The blockers are merged by their id, so
 * writing a blocker with `resolved: true` replaces the blocker of the same
 * id - and a blocker that is resolved is not a blocker any more: the task
 * runs again, and the state must not carry the failure of the last round.
 */
export function mergeBlockers(left: Blocker[], right: Blocker[]): Blocker[] {
  return mergeById(left, right).filter((blocker) => blocker.resolved !== true);
}

/**
 * Merge two verification states by check `name`: the right side wins on a
 * shared name, new names are appended.
 */
export function mergeVerification(left: VerificationState, right: VerificationState): VerificationState {
  return { checks: mergeByKey(left?.checks ?? [], right?.checks ?? [], (check) => check.name) };
}
