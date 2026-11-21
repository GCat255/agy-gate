import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/cli-args.mjs';

test('parseCliArgs handles --version, --help, models, doctor', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'help' });
  assert.deepEqual(parseCliArgs(['--version']), { command: 'version' });
  assert.deepEqual(parseCliArgs(['models']), { command: 'models' });
  assert.deepEqual(parseCliArgs(['doctor']), { command: 'doctor' });
});

test('parseCliArgs parses serve flags including --stdio, --hostname, --port', () => {
  assert.deepEqual(parseCliArgs(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '41234']), {
    command: 'serve',
    stdio: true,
    hostname: '127.0.0.1',
    port: 41234,
  });

  assert.deepEqual(parseCliArgs(['serve', '--hostname=0.0.0.0', '--port=8080']), {
    command: 'serve',
    stdio: false,
    hostname: '0.0.0.0',
    port: 8080,
  });
});
