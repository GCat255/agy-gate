import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
export const ROUTER_ROOT = path.resolve(MODULE_DIR, '..');
export const ROUTER_BIN_DIR = path.join(ROUTER_ROOT, 'bin');

const IS_WIN = process.platform === 'win32';

/**
 * Resolve the gateway's own data directory for session history and logs.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDataDir(env = process.env) {
  const override = env.AGY_ROUTER_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.config', 'agy-opencode-router');
}

/**
 * Check whether a candidate path points to this router's own entrypoints so we never recurse.
 * @param {string} candidate
 */
export function isRouterSelfPath(candidate) {
  if (!candidate) return false;
  const resolved = path.resolve(candidate).toLowerCase();
  const selfNames = [
    path.join(ROUTER_BIN_DIR, 'agy-opencode-router.mjs'),
    path.join(ROUTER_BIN_DIR, 'agy-opencode-router.cmd'),
    path.join(ROUTER_BIN_DIR, 'agy-opencode-router'),
  ].map((p) => path.resolve(p).toLowerCase());
  if (selfNames.includes(resolved)) return true;
  return resolved.endsWith(`${path.sep}agy-opencode-router.cmd`)
    || resolved.endsWith(`${path.sep}agy-opencode-router.mjs`)
    || resolved.endsWith(`${path.sep}agy-opencode-router`);
}

function existsFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readOpenChamberSettings(env = process.env) {
  const dir = env.OPENCHAMBER_DATA_DIR?.trim() || path.join(os.homedir(), '.config', 'openchamber');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Locate the real underlying `opencode` executable, never returning this router itself.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveRealOpenCode(env = process.env) {
  const explicit = env.AGY_ROUTER_REAL_OPENCODE?.trim();
  if (explicit && !isRouterSelfPath(explicit) && existsFile(explicit)) {
    return explicit;
  }

  const home = os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');

  const candidates = [];

  // Prefer native .exe over .cmd/.bat shims on Windows
  if (IS_WIN) {
    candidates.push(
      path.join(home, '.opencode', 'bin', 'opencode.exe'),
      path.join(localAppData, 'Programs', 'nodejs', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      path.join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      path.join(home, '.bun', 'bin', 'opencode.exe'),
    );
  }

  // Then check PATH hits (excluding our own router shim)
  try {
    const probe = spawnSync(IS_WIN ? 'where' : 'which', ['opencode'], {
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
    if (probe.status === 0) {
      for (const raw of String(probe.stdout || '').split(/\r?\n/)) {
        const hit = raw.trim();
        if (!hit || isRouterSelfPath(hit) || !existsFile(hit)) continue;
        if (IS_WIN && !/\.(exe|cmd|bat)$/i.test(hit)) continue;
        // Unwrap npm opencode.cmd shim to native opencode.exe when present beside it
        if (IS_WIN && /\.(cmd|bat)$/i.test(hit)) {
          const unwrapped = path.join(path.dirname(hit), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
          if (existsFile(unwrapped)) candidates.push(unwrapped);
        }
        candidates.push(hit);
      }
    }
  } catch {
    // Ignore probe errors and fall back to well-known locations
  }

  if (IS_WIN) {
    candidates.push(
      path.join(home, '.opencode', 'bin', 'opencode.cmd'),
      path.join(localAppData, 'Programs', 'nodejs', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.cmd'),
    );
  } else {
    candidates.push(
      path.join(home, '.opencode', 'bin', 'opencode'),
      path.join(home, '.bun', 'bin', 'opencode'),
      path.join(home, '.local', 'bin', 'opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
    );
  }

  // Also check OpenChamber settings only if it does NOT point to this router
  const settings = readOpenChamberSettings(env);
  if (typeof settings.opencodeBinary === 'string') {
    const configured = settings.opencodeBinary.trim();
    if (configured && !isRouterSelfPath(configured) && existsFile(configured)) {
      candidates.push(configured);
    }
  }

  for (const candidate of candidates) {
    if (!isRouterSelfPath(candidate) && existsFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Locate the `agy` executable on this machine.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgyBinary(env = process.env) {
  const explicit = env.AGY_ROUTER_AGY_BIN?.trim();
  if (explicit && existsFile(explicit)) return explicit;

  const home = os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const candidates = IS_WIN
    ? [
        path.join(localAppData, 'magpie-agy-cli', 'agy.exe'),
        path.join(home, '.local', 'bin', 'agy.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
      ];

  try {
    const probe = spawnSync(IS_WIN ? 'where' : 'which', ['agy'], {
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
    if (probe.status === 0) {
      for (const raw of String(probe.stdout || '').split(/\r?\n/)) {
        const hit = raw.trim();
        if (!hit || !existsFile(hit)) continue;
        if (IS_WIN && !/\.(exe|cmd|bat)$/i.test(hit)) continue;
        candidates.push(hit);
      }
    }
  } catch {
    // Ignore probe errors
  }

  for (const candidate of candidates) {
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate optional `magpie.exe` wrapper used for `agy env` injection on Windows.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveMagpieBinary(env = process.env) {
  const explicit = env.AGY_ROUTER_MAGPIE_BIN?.trim();
  if (explicit && existsFile(explicit)) return explicit;

  if (!IS_WIN) return null;
  const home = os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidate = path.join(localAppData, 'Programs', 'magpie', 'magpie.exe');
  return existsFile(candidate) ? candidate : null;
}
