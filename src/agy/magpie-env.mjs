import { spawnSync } from 'node:child_process';
import { resolveMagpieBinary } from '../core/config.mjs';

const CACHE_TTL_MS = 60_000;
let cached = null;
let cachedAt = 0;

/**
 * Parse KEY=VALUE lines emitted by `magpie.exe agy env`.
 * Never logs secret values.
 * @param {string} stdout
 */
export function parseMagpieEnvOutput(stdout) {
  const envPatch = {};
  let settingsPath = null;
  let defaultModel = null;

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!value) continue;

    if (key === 'settings') {
      settingsPath = value;
    } else if (key === 'model') {
      defaultModel = value;
    } else {
      envPatch[key] = value;
    }
  }

  return { envPatch, settingsPath, defaultModel };
}

/**
 * Resolve runtime env & `--settings` from `magpie.exe agy env` when available.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 */
export function loadMagpieAgyEnv(options = {}) {
  const env = options.env || process.env;
  if (!options.forceRefresh && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const magpieBin = resolveMagpieBinary(env);
  if (!magpieBin) {
    cached = { available: false, envPatch: {}, settingsPath: null, defaultModel: null };
    cachedAt = Date.now();
    return cached;
  }

  try {
    const res = spawnSync(magpieBin, ['agy', 'env'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (res.status === 0 && res.stdout) {
      const parsed = parseMagpieEnvOutput(res.stdout);
      cached = { available: true, ...parsed };
      cachedAt = Date.now();
      return cached;
    }
  } catch {
    // Fall back to empty patch when magpie probe fails
  }

  return { available: false, envPatch: {}, settingsPath: null, defaultModel: null };
}

/**
 * Return a redacted summary safe for logs and `doctor` output.
 * @param {ReturnType<typeof loadMagpieAgyEnv>} info
 */
export function redactMagpieSummary(info) {
  return {
    available: Boolean(info?.available),
    envKeys: Object.keys(info?.envPatch || {}),
    hasSettings: Boolean(info?.settingsPath),
    defaultModel: info?.defaultModel || null,
  };
}
