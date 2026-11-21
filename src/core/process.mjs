import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/**
 * Build spawn command & args, wrapping Windows `.cmd`/`.bat` scripts via `cmd.exe`.
 * @param {string} binary
 * @param {string[]} args
 */
export function buildSpawnSpec(binary, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(binary)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', binary, ...args],
    };
  }
  return { command: binary, args };
}

/**
 * Resolve npm invocation (`node <npm-cli.js>` when beside current Node binary, otherwise `npm` / `npm.cmd`).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveNpmInvocation(env = process.env) {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { file: process.execPath, prefixArgs: [candidate] };
    }
  }
  return { file: IS_WIN ? 'npm.cmd' : 'npm', prefixArgs: [], env };
}
