import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FALLBACK_UI_BLOCKS_GUIDANCE = [
  'UI blocks: a fenced ```openui-lang block in your reply draws native interactive UI inside OpenChamber; keep narrative explanation in Markdown around it.',
  'Syntax: one statement per line, `name = Component(args);` with `root = Stack([...])` on line 1. Positional args only; strings `"..."`, arrays `[...]`, objects `{key: value}`.',
].join('\n');

const HEADLESS_CHOICE_RULE =
  'IMPORTANT (agy-cli headless mode): NEVER call `ask_question` — it returns empty immediately without waiting for UI input. '
  + 'For interactive choices or forms, either call `openchamber_render` (`action: "render.page"`, `ui` or `html`, `title`, `awaitAnswer: true`), '
  + 'or write a fenced ```openui-lang block in your Markdown reply.';

const cachedWebRootByKey = new Map();
let cachedGuidance = null;
const cachedToolsByKey = new Map();

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
 * Build a compact, deterministic first-turn pointer (~320 chars) for new OpenChamber conversations.
 * Full `openui-lang` syntax lives lazily inside MCP `openchamber_render` schema so normal turns pay near-zero token overhead and prompt prefix cache stays intact.
 * @param {{ env?: NodeJS.ProcessEnv, hasMcpBridge?: boolean }} [options]
 */
export async function buildSessionGuidancePrefix(options = {}) {
  if (options.hasMcpBridge !== false) {
    return [
      '<openchamber_runtime_guidance>',
      HEADLESS_CHOICE_RULE,
      'Read MCP `openchamber_render` schema before rendering UI for complete `openui-lang` component signatures and `render.page` arguments.',
      '</openchamber_runtime_guidance>',
    ].join('\n');
  }
  const { uiBlocksGuidance } = await loadOpenChamberGuidance(options);
  return [
    '<openchamber_runtime_guidance>',
    HEADLESS_CHOICE_RULE,
    uiBlocksGuidance,
    '</openchamber_runtime_guidance>',
  ].join('\n');
}

function normalizeJsonSchemaForMcp(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  return schema;
}

/**
 * Extract tool schemas directly from installed OpenChamber `agent-tool/runtime.js` using an in-memory stub.
 * Appends live `UI_BLOCKS_GUIDANCE` lazily into `openchamber_render` description so `agy` fetches it on demand
 * without bloating every session's prompt prefix or hurting KV cache hit rate.
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

  const guidance = await loadOpenChamberGuidance({ env, forceRefresh: options.forceRefresh });

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
            path,
            instanceDir: path.join(os.tmpdir(), 'agy-router-probe'),
            getActiveHost: () => '127.0.0.1:3000',
          });
          await runtime.materializePlugin(flags);
          const pluginSource = files.get('index.js');
          if (pluginSource) {
            const tools = await evaluatePluginSourceForSchemas(pluginSource, guidance);
            if (tools.length > 0) {
              tools.sort((a, b) => a.name.localeCompare(b.name));
              cachedToolsByKey.set(cacheKey, tools);
              return tools;
            }
          }
        }
      } catch {
        // Fall through to built-in fallback
      }
    }
  }

  const fallback = buildFallbackToolSpecs(flags, guidance);
  fallback.sort((a, b) => a.name.localeCompare(b.name));
  cachedToolsByKey.set(cacheKey, fallback);
  return fallback;
}

function enrichToolDescription(name, description, guidance) {
  if (name !== 'openchamber_render') return description;
  const parts = [description, HEADLESS_CHOICE_RULE];
  if (guidance?.renderPageGuidance) parts.push(guidance.renderPageGuidance);
  if (guidance?.uiBlocksGuidance) parts.push(guidance.uiBlocksGuidance);
  return parts.filter(Boolean).join('\n\n');
}

async function evaluatePluginSourceForSchemas(pluginSource, guidance) {
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
            const name = String(spec.name);
            captured.push({
              name,
              description: enrichToolDescription(name, String(spec.description || name), guidance),
              inputSchema: normalizeJsonSchemaForMcp(spec.input),
            });
          },
        });
      },
    },
  });
  return captured;
}

function buildFallbackToolSpecs(flags, guidance) {
  const genericSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'OpenChamber tool action' },
      parameters: { type: 'object', description: 'Parameters for the action', additionalProperties: true },
    },
    required: ['action'],
    additionalProperties: true,
  };
  const renderSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['render.page'], description: 'OpenChamber render action ("render.page")' },
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Page title' },
          ui: { type: 'string', description: 'openui-lang program drawing interactive components' },
          html: { type: 'string', description: 'Self-contained HTML document' },
          awaitAnswer: { type: 'boolean', description: 'Block until user submits the page or form' },
          answerLater: { type: 'boolean', description: 'Return immediately and receive answer as a message later' },
        },
        additionalProperties: true,
      },
    },
    required: ['action'],
    additionalProperties: true,
  };
  const list = [];
  if (flags.includeControl) list.push({ name: 'openchamber', description: 'Control OpenChamber projects, sessions, and file panel.', inputSchema: genericSchema });
  if (flags.includeRender) list.push({ name: 'openchamber_render', description: enrichToolDescription('openchamber_render', 'Draw an inline HTML or openui-lang UI page in OpenChamber chat.', guidance), inputSchema: renderSchema });
  if (flags.includeWeb) list.push({ name: 'openchamber_web', description: "Interact with OpenChamber's browser panel.", inputSchema: genericSchema });
  if (flags.includeMemory) list.push({ name: 'openchamber_memory', description: 'Read and save cross-session OpenChamber memories.', inputSchema: genericSchema });
  if (flags.includeSchedule) list.push({ name: 'openchamber_schedule', description: 'Manage OpenChamber scheduled tasks.', inputSchema: genericSchema });
  return list;
}
