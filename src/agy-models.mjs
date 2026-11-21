import { spawnSync } from 'node:child_process';
import { resolveAgyBinary } from './config.mjs';
import { loadMagpieAgyEnv } from './magpie-env.mjs';
import { buildSpawnSpec } from './upstream.mjs';

export const AGY_PROVIDER_ID = 'agy-cli';
export const AGY_PROVIDER_NAME = 'Agy CLI';

const MODEL_CACHE_TTL_MS = 5 * 60_000;
let cachedCatalog = null;
let cachedAt = 0;

const FALLBACK_MODELS = [
  { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
];

/**
 * Parse lines from `agy models` (`<id>\t<displayName>`).
 * @param {string} stdout
 */
export function parseAgyModelsOutput(stdout) {
  const models = [];
  const seen = new Set();

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching available models/i.test(line)) continue;

    const tabIndex = line.indexOf('\t');
    let id;
    let name;
    if (tabIndex > 0) {
      id = line.slice(0, tabIndex).trim();
      name = line.slice(tabIndex + 1).trim() || id;
    } else {
      const parts = line.split(/\s{2,}/);
      id = parts[0]?.trim();
      name = parts[1]?.trim() || id;
    }

    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }

  return models;
}

/**
 * Build OpenCode 2.3.2 `Provider.Info` for the virtual `agy-cli` provider.
 */
export function buildAgyProviderInfo() {
  return {
    id: AGY_PROVIDER_ID,
    name: AGY_PROVIDER_NAME,
    activation: 'enabled',
    package: AGY_PROVIDER_ID,
  };
}

/**
 * Build an OpenCode 2.3.2 `Model.Info` record matching `@opencode/schema/dist/model.d.ts`.
 * @param {{ id: string, name: string }} entry
 */
export function toOpenCodeModelInfo(entry) {
  return {
    id: entry.id,
    modelID: entry.id,
    providerID: AGY_PROVIDER_ID,
    name: entry.name,
    type: 'chat',
    capabilities: {
      tools: true,
      input: ['text'],
      output: ['text'],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: {
      context: 1_000_000,
      output: 65_536,
    },
  };
}

/**
 * Fetch available `agy-cli` models (cached) and convert to OpenCode schema shapes.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 */
export function getAgyCatalog(options = {}) {
  if (!options.forceRefresh && cachedCatalog && Date.now() - cachedAt < MODEL_CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const env = options.env || process.env;
  const useMagpie = env.AGY_ROUTER_USE_MAGPIE === '1';
  const agyBin = resolveAgyBinary(env);
  let rawModels = [];

  if (agyBin) {
    const childEnv = { ...env };
    const args = [];
    if (useMagpie) {
      const magpie = loadMagpieAgyEnv({ env });
      Object.assign(childEnv, magpie.envPatch);
      if (magpie.settingsPath) args.push('--settings', magpie.settingsPath);
    } else {
      delete childEnv.GEMINI_API_KEY;
      delete childEnv.GOOGLE_GEMINI_BASE_URL;
    }
    args.push('models');

    try {
      const spec = buildSpawnSpec(agyBin, args);
      const res = spawnSync(spec.command, spec.args, {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        env: childEnv,
      });
      if (res.status === 0 && res.stdout) {
        rawModels = parseAgyModelsOutput(res.stdout).filter((m) => useMagpie || !m.id.startsWith('magpie/'));
      }
    } catch {
      // Fall back to static seed list on probe error
    }
  }

  const source = rawModels.length > 0 ? 'live' : 'fallback';
  const list = rawModels.length > 0 ? rawModels : FALLBACK_MODELS;
  cachedCatalog = {
    source,
    provider: buildAgyProviderInfo(),
    models: list.map(toOpenCodeModelInfo),
  };
  cachedAt = Date.now();
  return cachedCatalog;
}
