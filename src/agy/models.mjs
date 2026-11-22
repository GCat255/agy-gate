import { spawnSync } from 'node:child_process';
import { resolveAgyBinary } from '../core/config.mjs';
import { buildSpawnSpec } from '../core/process.mjs';
import { loadMagpieAgyEnv } from './magpie-env.mjs';

export const AGY_PROVIDER_ID = 'agy-cli';
export const AGY_PROVIDER_NAME = 'Agy CLI';

export const VARIANT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const SUFFIX_RE = /^(.+)-(low|medium|high|xhigh|max)$/;
const NAME_SUFFIX_RE = /^(.+?)\s*\((Low|Medium|High|XHigh|Max)\)$/i;

const MODEL_CACHE_TTL_MS = 5 * 60_000;
let cachedCatalog = null;
let cachedAt = 0;

const FALLBACK_MODELS = [
  { id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
  { id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
  { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
  { id: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
  { id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
  { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
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
 * Group `agy` concrete tier models (`gemini-4-neon-high`, `gemini-4-neon-low`)
 * into OpenChamber native multi-variant models (`id: "gemini-4-neon"`, `variants: [...]`).
 * Groups only when >= 2 tiers exist for the same base ID (matching `agy acp` configOptions).
 * @param {Array<{ id: string, name: string }>} rawModels
 */
export function groupAgyModels(rawModels) {
  /** @type {Map<string, { entries: Array<{ id: string, name: string, variant: string | null, baseName: string }> }>} */
  const buckets = new Map();

  for (const entry of rawModels) {
    const idMatch = entry.id.match(SUFFIX_RE);
    if (idMatch) {
      const baseId = idMatch[1];
      const variant = idMatch[2];
      const nameMatch = entry.name.match(NAME_SUFFIX_RE);
      const baseName = nameMatch ? nameMatch[1].trim() : entry.name;
      if (!buckets.has(baseId)) buckets.set(baseId, { entries: [] });
      buckets.get(baseId).entries.push({ id: entry.id, name: entry.name, variant, baseName });
    } else {
      buckets.set(entry.id, {
        entries: [{ id: entry.id, name: entry.name, variant: null, baseName: entry.name }],
      });
    }
  }

  /** @type {Array<{ id: string, name: string, variants: string[] }>} */
  const grouped = [];
  /** @type {Map<string, Map<string, string>>} */
  const variantTargets = new Map();

  for (const [baseId, bucket] of buckets.entries()) {
    const hasMultipleTiers = bucket.entries.length >= 2 && bucket.entries.every((e) => e.variant !== null);
    if (!hasMultipleTiers) {
      for (const item of bucket.entries) {
        grouped.push({ id: item.id, name: item.name, variants: [] });
        variantTargets.set(item.id, new Map([['__default__', item.id]]));
      }
      continue;
    }

    const sorted = [...bucket.entries].sort(
      (a, b) => VARIANT_ORDER.indexOf(a.variant) - VARIANT_ORDER.indexOf(b.variant),
    );
    const targetMap = new Map();
    const variants = [];
    for (const item of sorted) {
      variants.push(item.variant);
      targetMap.set(item.variant, item.id);
    }

    const preferred =
      targetMap.get('high') || targetMap.get('medium') || sorted[0].id;
    targetMap.set('__default__', preferred);

    variantTargets.set(baseId, targetMap);
    grouped.push({
      id: baseId,
      name: sorted[0].baseName,
      variants,
    });
  }

  return { grouped, variantTargets };
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
 * Determine whether an `agy-cli` model accepts image inputs.
 * Text-only models such as `gpt-oss-*` stay text-only; Gemini/Claude models support images.
 * @param {string} modelId
 */
export function modelSupportsImageInput(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('gpt-oss-')) return false;
  return true;
}

/**
 * Build an OpenCode 2.3.2 `Model.Info` record matching `@opencode/schema/dist/model.d.ts`.
 * @param {{ id: string, name: string, variants?: string[] }} entry
 */
export function toOpenCodeModelInfo(entry) {
  const variants = Array.isArray(entry.variants)
    ? entry.variants.map((v) => ({ id: v, settings: {} }))
    : [];
  const inputModalities = modelSupportsImageInput(entry.id) ? ['text', 'image'] : ['text'];

  return {
    id: entry.id,
    modelID: entry.id,
    providerID: AGY_PROVIDER_ID,
    name: entry.name,
    type: 'chat',
    capabilities: {
      tools: true,
      input: inputModalities,
      output: ['text'],
    },
    variants,
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
  const { grouped, variantTargets } = groupAgyModels(list);

  cachedCatalog = {
    source,
    provider: buildAgyProviderInfo(),
    models: grouped.map(toOpenCodeModelInfo),
    variantTargets,
    rawIds: new Set(list.map((m) => m.id)),
  };
  cachedAt = Date.now();
  return cachedCatalog;
}

/**
 * Resolve OpenChamber `(modelID, variant)` to the concrete `agy.exe --model` ID.
 * Preserves backward compatibility if `modelID` is already a concrete ID.
 * @param {string} modelID
 * @param {string | null | undefined} variant
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveRealAgyModelId(modelID, variant, options = {}) {
  const catalog = getAgyCatalog(options);
  const targets = catalog.variantTargets?.get(modelID);
  if (targets) {
    if (variant && targets.has(variant)) return targets.get(variant);
    return targets.get('__default__') || modelID;
  }

  // Handle legacy concrete ID with explicit variant switch
  const suffix = modelID.match(SUFFIX_RE);
  if (suffix && variant) {
    const baseTargets = catalog.variantTargets?.get(suffix[1]);
    if (baseTargets?.has(variant)) return baseTargets.get(variant);
  }

  return modelID;
}
