import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

/** Check every shipped implementation, fixture and maintenance script. A fixed
 * short file list missed newly added consumer workflows in the first release. */
let count = 0;
for (const directory of ['src', 'test', 'scripts']) {
  for (const file of await fs.readdir(directory, { recursive: true })) {
    if (!/\.m?js$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', directory + '/' + file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    count++;
  }
}
console.log(`Checked ${count} JavaScript files.`);
