import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Wakeable } from './launchd.ts';

/** Where a job's wake files land: launchd's `QueueDirectories` starts the job while the directory holds a file, and once more after a file lands during a run, so no wake is lost. */
export function wakeDirectory(stateDirectory: string, job: Wakeable): string { return join(stateDirectory, 'wake', job); }
export interface Woken { job: Wakeable; file: string }
/** Leaves one wake file per job. The name carries the time and the caller's pid; two nudges in the same millisecond from one process overwrite each other, which still wakes the job once. */
export function nudge(stateDirectory: string, jobs: readonly Wakeable[], now = Date.now()): Woken[] {
  return jobs.map(job => {
    const directory = wakeDirectory(stateDirectory, job);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${now}-${process.pid}`);
    writeFileSync(file, '', { mode: 0o600 });
    return { job, file };
  });
}
/** Removes every wake file of the job and returns how many there were. Never creates the directory: a tick that woke nothing leaves the state directory as it was. */
export function consumeWakes(stateDirectory: string, job: Wakeable): number {
  const directory = wakeDirectory(stateDirectory, job);
  if (!existsSync(directory)) return 0;
  const names = readdirSync(directory);
  for (const name of names) rmSync(join(directory, name), { force: true });
  return names.length;
}
