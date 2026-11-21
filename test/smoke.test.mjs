import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agy-gate.mjs');
const OCC_CLI = path.join(ROOT, 'bin', 'occ.mjs');

test('cli --help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /agy-gate/);

  const occRes = spawnSync(process.execPath, [OCC_CLI, '--help'], { encoding: 'utf8' });
  assert.equal(occRes.status, 0);
  assert.match(occRes.stdout, /occ/);
});
