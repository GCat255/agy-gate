import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FALLBACK_UI_BLOCKS_GUIDANCE = [
  'UI blocks: a fenced ```openui-lang block in your reply draws native interactive UI inside OpenChamber; keep narrative explanation in Markdown around it.',
  'Syntax: one statement per line, `name = Component(args);` with `root = Stack([...])` on line 1. Positional args only; strings `"..."`, arrays `[...]`, objects `{key: value}`.',
].join('\n');

const HEADLESS_CHOICE_RULE =
  'IMPORTANT: NEVER call `ask_question` (returns empty). '
  + 'For interactive choices/forms, use `openchamber_render` (`render.page`, `ui`/`html`, `awaitAnswer: true`) or ```openui-lang blocks. '
  + 'For subagents, use native `invoke_subagent`/`send_message`/`manage_subagents` only (never `openchamber` `ownWork`/`returnResult`).';

const FALLBACK_TOOL_CONTRACT = {
  source: 'fallback',
  semanticRoles: {
    edit: 'edit',
    execute: 'execute',
    glob: 'glob',
    grep: 'grep',
    patch: 'patch',
    question: 'question',
    read: 'read',
    shell: 'shell',
    skill: 'skill',
    subagent: 'subagent',
    todowrite: 'todowrite',
    webfetch: 'webfetch',
    websearch: 'websearch',
    write: 'write',
    sessionRename: 'session_rename',
    sessionMove: 'session_move',
    models: 'models',
  },
  canonicalTools: {
    read: { displayName: 'Read File', category: 'file', inputFields: ['path', 'offset', 'limit'] },
    write: { displayName: 'Write File', category: 'file', inputFields: ['path', 'content'] },
    edit: { displayName: 'Edit File', category: 'file', inputFields: ['path', 'oldString', 'newString', 'replaceAll'] },
    patch: { displayName: 'Apply Patch', category: 'file', inputFields: ['patchText'] },
    execute: { displayName: 'Script', category: 'code', inputFields: ['code'] },
    shell: { displayName: 'Shell Command', category: 'system', inputFields: ['command', 'description', 'timeout', 'background'] },
    grep: { displayName: 'Search Files', category: 'search', inputFields: ['pattern', 'path', 'include', 'literal', 'caseSensitive'] },
    glob: { displayName: 'Find Files', category: 'search', inputFields: ['pattern', 'path'] },
    subagent: { displayName: 'Agent Task', category: 'ai', inputFields: ['description', 'prompt', 'agent'] },
    webfetch: { displayName: 'Fetch URL', category: 'web', inputFields: ['url', 'format', 'timeout'] },
    websearch: { displayName: 'Web Search', category: 'web', inputFields: ['query', 'numResults', 'type'] },
    codesearch: { displayName: 'Code Search', category: 'web', inputFields: ['query', 'tokensNum'] },
    skill: { displayName: 'Load Skill', category: 'ai', inputFields: ['id'] },
    question: { displayName: 'Question', category: 'ai', inputFields: ['questions'] },
    todowrite: { displayName: 'Tasks', category: 'ai', inputFields: [] },
  },
};

const cachedWebRootByKey = new Map();
const cachedGuidanceByKey = new Map();
const cachedToolsByKey = new Map();
const cachedToolContractByKey = new Map();
let latestResolvedToolContract = FALLBACK_TOOL_CONTRACT;

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

  if (env.npm_config_prefix?.trim()) {
    const prefix = path.resolve(env.npm_config_prefix.trim());
    candidates.push(path.join(prefix, 'node_modules', '@openchamber', 'web'));
    candidates.push(path.join(prefix, 'lib', 'node_modules', '@openchamber', 'web'));
  }
  if (env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@openchamber', 'web'));
  }
  candidates.push('/opt/homebrew/lib/node_modules/@openchamber/web');
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

  if (!found) {
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const probe = spawnSync(npmCmd, ['root', '-g'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        env,
      });
      if (probe.status === 0 && probe.stdout) {
        const candidate = path.join(probe.stdout.trim(), '@openchamber', 'web');
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
          found = candidate;
        }
      }
    } catch {
      // Ignore global npm probe failures
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
  const env = options.env || process.env;
  const webRoot = resolveOpenChamberWebRoot(env);
  const cacheKey = webRoot || 'none';
  if (!options.forceRefresh && cachedGuidanceByKey.has(cacheKey)) {
    return cachedGuidanceByKey.get(cacheKey);
  }

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

  const result = {
    source,
    uiBlocksGuidance,
    renderPageGuidance,
  };
  cachedGuidanceByKey.set(cacheKey, result);
  return result;
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
      'Check MCP `openchamber_render` schema before rendering UI for full `openui-lang` & `render.page` args.',
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

async function loadToolSpecsWithMeta(options = {}) {
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
              const entry = { source: 'openchamber-live', tools };
              cachedToolsByKey.set(cacheKey, entry);
              return entry;
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
  const entry = { source: 'fallback', tools: fallback };
  cachedToolsByKey.set(cacheKey, entry);
  return entry;
}

/**
 * Extract tool schemas directly from installed OpenChamber `agent-tool/runtime.js` using an in-memory stub.
 * Appends live `UI_BLOCKS_GUIDANCE` lazily into `openchamber_render` description so `agy` fetches it on demand
 * without bloating every session's prompt prefix or hurting KV cache hit rate.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 * @returns {Promise<Array<{ name: string, description: string, inputSchema: object }>>}
 */
export async function loadOpenChamberToolSpecs(options = {}) {
  const { tools } = await loadToolSpecsWithMeta(options);
  return tools;
}

/**
 * Extract balanced `{...}` object literal starting at `openBraceIndex` and safely parse it as JSON
 * without dynamic code evaluation.
 * @param {string} source
 * @param {number} openBraceIndex
 * @returns {any | null}
 */
function parseJsObjectLiteral(source, openBraceIndex) {
  if (openBraceIndex < 0 || source[openBraceIndex] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let quote = '';
  let escaped = false;
  let end = -1;

  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const raw = source.slice(openBraceIndex, end + 1);
  // Quote unquoted identifier keys outside string literals so JSON.parse handles Vite bundles cleanly.
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      let j = i + 1;
      let esc = false;
      let strBody = '';
      while (j < raw.length) {
        const sc = raw[j];
        if (esc) {
          strBody += sc === "'" ? "'" : `\\${sc}`;
          esc = false;
        } else if (sc === '\\') {
          esc = true;
        } else if (sc === q) {
          break;
        } else {
          strBody += sc === '"' ? '\\"' : sc;
        }
        j += 1;
      }
      out += `"${strBody}"`;
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '!' && (raw[i + 1] === '0' || raw[i + 1] === '1') && !/[\w$]/.test(raw[i + 2] || '')) {
      out += raw[i + 1] === '0' ? 'true' : 'false';
      i += 2;
      continue;
    }
    if (raw.startsWith('void 0', i) && !/[\w$]/.test(raw[i + 6] || '')) {
      out += 'null';
      i += 6;
      continue;
    }
    if ((ch === ',' || ch === '[') && i + 1 < raw.length) {
      out += ch;
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const prev = out.trimEnd().slice(-1);
      if (prev === '{' || prev === ',') {
        let j = i;
        while (j < raw.length && /[\w$]/.test(raw[j])) j += 1;
        let k = j;
        while (k < raw.length && /\s/.test(raw[k])) k += 1;
        if (raw[k] === ':') {
          out += `"${raw.slice(i, j)}"`;
          i = j;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function summarizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const fields = Array.isArray(entry.inputFields)
    ? entry.inputFields.map((f) => String(f?.key || '').trim()).filter(Boolean)
    : [];
  return {
    displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
    category: typeof entry.category === 'string' ? entry.category : '',
    inputFields: fields,
  };
}

/**
 * Dynamically discover OpenChamber frontend's canonical tool names & expected input fields
 * from `@openchamber/web/dist/assets/*.js` so upgrades without breaking signatures adapt automatically.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 */
export async function loadOpenChamberToolContract(options = {}) {
  const env = options.env || process.env;
  const webRoot = resolveOpenChamberWebRoot(env);
  const cacheKey = webRoot || 'none';
  if (!options.forceRefresh && cachedToolContractByKey.has(cacheKey)) {
    return cachedToolContractByKey.get(cacheKey);
  }

  let semanticRoles = { ...FALLBACK_TOOL_CONTRACT.semanticRoles };
  let canonicalTools = { ...FALLBACK_TOOL_CONTRACT.canonicalTools };
  let foundRoles = false;
  let foundRegistry = false;

  if (webRoot) {
    const assetsDir = path.join(webRoot, 'dist', 'assets');
    try {
      if (fs.existsSync(assetsDir)) {
        const jsFiles = fs
          .readdirSync(assetsDir)
          .filter((name) => name.endsWith('.js') && !name.startsWith('vendor-'))
          .map((name) => {
            const fullPath = path.join(assetsDir, name);
            let size = 0;
            try {
              size = fs.statSync(fullPath).size;
            } catch {}
            return { fullPath, size };
          })
          // Check substantial app bundles first; small files are syntax/theme assets.
          .sort((a, b) => b.size - a.size)
          .filter((item) => item.size >= 64 * 1024);

        for (const item of jsFiles) {
          if (foundRoles && foundRegistry) break;
          let content = '';
          try {
            content = fs.readFileSync(item.fullPath, 'utf8');
          } catch {
            continue;
          }

          if (!foundRoles) {
            const roleMatch = /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*(\{edit:"edit",execute:"execute"[^}]+\})/.exec(content);
            if (roleMatch) {
              const parsed = parseJsObjectLiteral(roleMatch[1], 0);
              if (parsed && typeof parsed === 'object' && parsed.read && parsed.write && parsed.shell) {
                semanticRoles = { ...semanticRoles, ...parsed };
                foundRoles = true;
              }
            }
          }

          if (!foundRegistry) {
            const regMatch = /\b[A-Za-z_$][\w$]*\s*=\s*(\{read:\{displayName:"Read File"[^;]+)/.exec(content);
            if (regMatch) {
              const braceIdx = content.indexOf('{', regMatch.index);
              const parsed = parseJsObjectLiteral(content, braceIdx);
              if (parsed && typeof parsed === 'object' && parsed.read && parsed.write) {
                const normalized = {};
                for (const [toolName, meta] of Object.entries(parsed)) {
                  const summary = summarizeRegistryEntry(meta);
                  if (summary) normalized[toolName] = summary;
                }
                if (Object.keys(normalized).length > 0) {
                  canonicalTools = { ...canonicalTools, ...normalized };
                  foundRegistry = true;
                }
              }
            }
          }
        }
      }
    } catch {
      // Retain built-in fallback
    }
  }

  const contract = {
    source: foundRoles || foundRegistry ? 'openchamber-live' : 'fallback',
    semanticRoles,
    canonicalTools,
  };
  cachedToolContractByKey.set(cacheKey, contract);
  latestResolvedToolContract = contract;
  return contract;
}

/**
 * Synchronously return the latest resolved OpenChamber tool contract (or built-in fallback).
 */
export function getCachedOpenChamberToolContract() {
  return latestResolvedToolContract;
}

/**
 * Probe whether live OpenChamber runtime bridges (`openui-lang` guidance, tool schemas & UI tool contract)
 * resolved cleanly or silently degraded to static fallback after an OpenChamber upgrade.
 * @param {{ env?: NodeJS.ProcessEnv, forceRefresh?: boolean }} [options]
 */
export async function probeOpenChamberCompat(options = {}) {
  const env = options.env || process.env;
  const webRoot = resolveOpenChamberWebRoot(env);
  let webVersion = null;
  if (webRoot) {
    try {
      webVersion = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8')).version || null;
    } catch {
      webVersion = null;
    }
  }

  const [guidance, toolMeta, toolContract] = await Promise.all([
    loadOpenChamberGuidance({ env, forceRefresh: options.forceRefresh }),
    loadToolSpecsWithMeta({ env, forceRefresh: options.forceRefresh }),
    loadOpenChamberToolContract({ env, forceRefresh: options.forceRefresh }),
  ]);

  const degraded = !webRoot
    || guidance.source !== 'openchamber-live'
    || toolMeta.source !== 'openchamber-live'
    || toolContract.source !== 'openchamber-live';

  return {
    webRoot,
    webVersion,
    guidanceSource: guidance.source,
    toolSpecSource: toolMeta.source,
    toolContractSource: toolContract.source,
    canonicalToolNames: Object.keys(toolContract.canonicalTools),
    toolNames: toolMeta.tools.map((t) => t.name),
    degraded,
  };
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
          remove: () => {},
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
    session: {
      hook: () => {},
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
