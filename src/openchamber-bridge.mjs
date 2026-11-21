import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FALLBACK_UI_BLOCKS_GUIDANCE = [
  'UI blocks: a fenced ```openui-lang block in your reply draws native interactive UI inside OpenChamber; keep narrative explanation in Markdown around it.',
  'Use a block for comparisons, flows, charts, status summaries, or interactive decisions (Card + Choice + Input + Slider + DateInput + Button).',
  'Syntax: one statement per line, `name = Component(args);` with `root = Stack([...])` on line 1. Positional args only; strings `"..."`, arrays `[...]`, objects `{key: value}`.',
  'Buttons on the same Card/value form one decision and submit choices back cleanly when clicked.',
].join('\n');

const FALLBACK_RENDER_GUIDANCE = [
  'When OpenChamber MCP tools (`openchamber_render`, `openchamber`, `openchamber_web`, `openchamber_memory`, etc.) are available in your tool list, you can invoke them directly.',
  'Never call `ask_question` in this headless runtime because it returns immediately without waiting for UI input; use an `openui-lang` decision card or `openchamber_render` with `awaitAnswer: true` instead.',
].join('\n');

const cachedWebRootByKey = new Map();
let cachedGuidance = null;
let cachedToolsByKey = new Map();

/**
 * Locate the installed `@openchamber/web` directory dynamically so upgrades are picked up automatically.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveOpenChamberWebRoot(env = process.env) {
  const key = `${env.OPENCHAMBER_WEB_ROOT || ''}|${process.execPath}`;
  if (cachedWebRootByKey.has(key)) return cachedWebRootByKey.get(key);

  const candidates = [];
  if (env.OPENCHAMBER_WEB_ROOT?.trim()) {
    candidates.push(path.resolve(env.OPENCHAMBER_WEB_ROOT.trim()));
  }

  // Global npm install beside node executable (e.g. AppData\Local\Programs\nodejs\node_modules\@openchamber\web)
  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, 'node_modules', '@openchamber', 'web'));
  candidates.push(path.join(execDir, '..', 'node_modules', '@openchamber', 'web'));

  if (env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@openchamber', 'web'));
  }
  candidates.push('/usr/local/lib/node_modules/@openchamber/web');
  candidates.push('/usr/lib/node_modules/@openchamber/web');

  let found = null;
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        found = dir;
        break;
      }
    } catch {
      // Ignore inaccessible paths
    }
  }

  cachedWebRootByKey.set(key, found);
  return found;
}

/**
 * Resolve OpenChamber data directory (`~/.config/openchamber` unless overridden).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveOpenChamberDataDir(env = process.env) {
  if (env.OPENCHAMBER_DATA_DIR?.trim()) {
    return path.resolve(env.OPENCHAMBER_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

/**
 * Read OpenChamber tool feature flags from `settings.json`, matching `managed-config-file.js` defaults.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readOpenChamberToolFlags(env = process.env) {
  let settings = {};
  try {
    const raw = fs.readFileSync(path.join(resolveOpenChamberDataDir(env), 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') settings = parsed;
  } catch {
    // Missing or unreadable settings uses OpenChamber defaults
  }

  return {
    includeControl: settings.agentControlToolEnabled !== false,
    includeSchedule: settings.agentScheduleToolEnabled !== false,
    includeWeb: settings.agentWebToolEnabled !== false,
    includeMemory: settings.agentMemoryToolEnabled === true,
    includeKnowledge: settings.agentKnowledgeToolEnabled !== false,
    includeNotify: settings.agentNotifyToolEnabled === true,
    includeRender: settings.agentRenderToolEnabled !== false,
    includeShare: false,
    includeImage: settings.agentImageToolEnabled === true,
    includeSecret: settings.agentSecretToolEnabled !== false,
    includeUsage: settings.agentUsageToolEnabled === true,
    includeTerminal: settings.agentTerminalToolEnabled === true,
    includeWorkflow: settings.agentWorkflowToolEnabled === true,
  };
}

/**
 * Load `UI_BLOCKS_GUIDANCE` and `RENDER_PAGE_GUIDANCE` dynamically from the installed OpenChamber package.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 */
export async function loadOpenChamberGuidance(options = {}) {
  if (!options.forceRefresh && cachedGuidance) return cachedGuidance;

  const env = options.env || process.env;
  const webRoot = resolveOpenChamberWebRoot(env);
  let uiBlocksGuidance = FALLBACK_UI_BLOCKS_GUIDANCE;
  let renderPageGuidance = '';
  let source = 'fallback';

  if (webRoot) {
    const uiBlocksMod = path.join(webRoot, 'build', 'server', 'lib', 'session-knowledge', 'ui-blocks-guidance.js');
    const runtimeMod = path.join(webRoot, 'build', 'server', 'lib', 'session-knowledge', 'runtime.js');

    try {
      if (fs.existsSync(uiBlocksMod)) {
        const mod = await import(pathToFileURL(uiBlocksMod).href);
        if (typeof mod?.UI_BLOCKS_GUIDANCE === 'string' && mod.UI_BLOCKS_GUIDANCE.trim()) {
          uiBlocksGuidance = mod.UI_BLOCKS_GUIDANCE.trim();
          source = 'openchamber-live';
        }
      }
    } catch {
      // Retain built-in fallback
    }

    try {
      if (fs.existsSync(runtimeMod)) {
        const mod = await import(pathToFileURL(runtimeMod).href);
        if (typeof mod?.RENDER_PAGE_GUIDANCE === 'string' && mod.RENDER_PAGE_GUIDANCE.trim()) {
          renderPageGuidance = mod.RENDER_PAGE_GUIDANCE.trim();
        }
      }
    } catch {
      // Optional
    }
  }

  cachedGuidance = {
    source,
    uiBlocksGuidance,
    renderPageGuidance,
  };
  return cachedGuidance;
}

/**
 * Build the one-time system instruction block prepended to the first turn of a new OpenChamber `agy` conversation.
 * @param {{ env?: NodeJS.ProcessEnv, hasMcpBridge?: boolean }} [options]
 */
export async function buildSessionGuidancePrefix(options = {}) {
  const { uiBlocksGuidance, renderPageGuidance } = await loadOpenChamberGuidance(options);
  const lines = [
    '<openchamber_runtime_guidance>',
    'You are running inside OpenChamber Web UI via agy-opencode-router.',
    'Do NOT call `ask_question` in this environment: headless mode cannot display native `ask_question` prompts and immediately returns empty.',
    options.hasMcpBridge !== false
      ? 'OpenChamber runtime tools (`openchamber`, `openchamber_render`, `openchamber_web`, etc.) are bridged as MCP tools when present in your tool list.'
      : 'Use embedded `openui-lang` fenced blocks for rich UI or interactive choices.',
    '',
    uiBlocksGuidance,
  ];
  if (renderPageGuidance) {
    lines.push('', renderPageGuidance);
  } else {
    lines.push('', FALLBACK_RENDER_GUIDANCE);
  }
  lines.push('</openchamber_runtime_guidance>');
  return lines.join('\n');
}

function normalizeJsonSchemaForMcp(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  return schema;
}

/**
 * Extract tool schemas directly from installed OpenChamber `agent-tool/runtime.js` using an in-memory stub
 * so OpenChamber upgrades automatically update all bridged MCP tools with zero disk side effects.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 * @returns {Promise<Array<{ name: string, description: string, inputSchema: object }>>}
 */
export async function loadOpenChamberToolSpecs(options = {}) {
  const env = options.env || process.env;
  const webRoot = resolveOpenChamberWebRoot(env);
  const flags = readOpenChamberToolFlags(env);
  const cacheKey = `${webRoot || 'none'}|${JSON.stringify(flags)}`;
  if (!options.forceRefresh && cachedToolsByKey.has(cacheKey)) {
    return cachedToolsByKey.get(cacheKey);
  }

  if (webRoot) {
    const agentToolRuntimePath = path.join(webRoot, 'build', 'server', 'lib', 'agent-tool', 'runtime.js');
    if (fs.existsSync(agentToolRuntimePath)) {
      try {
        const mod = await import(pathToFileURL(agentToolRuntimePath).href);
        if (typeof mod?.createAgentToolRuntime === 'function') {
          const files = new Map();
          const memFs = {
            mkdir: async () => undefined,
            writeFile: async (filePath, content) => {
              files.set(path.basename(filePath), String(content));
            },
          };
          const runtime = mod.createAgentToolRuntime({
            fsPromises: memFs,
            dataDir: path.join(os.tmpdir(), 'agy-router-probe'),
            getActiveHost: () => '127.0.0.1:3000',
          });
          await runtime.materializePlugin(flags);
          const pluginSource = files.get('index.js');
          if (pluginSource) {
            const tools = await evaluatePluginSourceForSchemas(pluginSource);
            if (tools.length > 0) {
              cachedToolsByKey.set(cacheKey, tools);
              return tools;
            }
          }
        }
      } catch {
        // Fall through to materialized plugin on disk or built-in fallback
      }
    }
  }

  const fallback = buildFallbackToolSpecs(flags);
  cachedToolsByKey.set(cacheKey, fallback);
  return fallback;
}

async function evaluatePluginSourceForSchemas(pluginSource) {
  // Rewrite default ESM export into a data-URL module cleanly loaded in memory.
  const dataUrl = `data:text/javascript;base64,${Buffer.from(pluginSource, 'utf8').toString('base64')}`;
  const pluginMod = await import(dataUrl);
  const plugin = pluginMod?.default;
  if (!plugin || typeof plugin.setup !== 'function') return [];

  const captured = [];
  await plugin.setup({
    tool: {
      transform: async (fn) => {
        await fn({
          namespace: () => {},
          add: (spec) => {
            if (!spec?.name) return;
            captured.push({
              name: String(spec.name),
              description: String(spec.description || spec.name),
              inputSchema: normalizeJsonSchemaForMcp(spec.input),
            });
          },
        });
      },
    },
  });
  return captured;
}

function buildFallbackToolSpecs(flags) {
  const genericSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'OpenChamber tool action' },
      parameters: { type: 'object', description: 'Parameters for the action', additionalProperties: true },
    },
    required: ['action'],
    additionalProperties: true,
  };
  const list = [];
  if (flags.includeControl) list.push({ name: 'openchamber', description: 'Control OpenChamber projects, sessions, and file panel.', inputSchema: genericSchema });
  if (flags.includeRender) list.push({ name: 'openchamber_render', description: 'Draw an inline HTML or openui-lang UI page in OpenChamber chat.', inputSchema: genericSchema });
  if (flags.includeWeb) list.push({ name: 'openchamber_web', description: "Interact with OpenChamber's browser panel.", inputSchema: genericSchema });
  if (flags.includeMemory) list.push({ name: 'openchamber_memory', description: 'Read and save cross-session OpenChamber memories.', inputSchema: genericSchema });
  if (flags.includeSchedule) list.push({ name: 'openchamber_schedule', description: 'Manage OpenChamber scheduled tasks.', inputSchema: genericSchema });
  return list;
}
