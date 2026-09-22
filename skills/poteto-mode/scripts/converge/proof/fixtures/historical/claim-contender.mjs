import { existsSync, writeFileSync } from 'node:fs';
import { claimRun } from '../../historical-dispatch.ts';

const [runFile, contender] = process.argv.slice(2);
const directory = new URL('.', `file://${runFile}`).pathname;
const waitFor = path => {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) Atomics.wait(waiter, 0, 0, 10);
};

try {
  const release = claimRun(runFile, {
    afterDeadOwner() {
      writeFileSync(`${directory}ready-${contender}`, 'ready\n');
      waitFor(`${directory}go`);
    },
  });
  writeFileSync(`${directory}result-${contender}`, 'acquired\n');
  waitFor(`${directory}release`);
  release();
} catch (error) {
  writeFileSync(`${directory}result-${contender}`, `rejected: ${error instanceof Error ? error.message : String(error)}\n`);
}
