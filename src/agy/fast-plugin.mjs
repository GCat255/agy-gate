import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAgyBinary } from '../core/config.mjs';
import { buildSpawnSpec } from '../core/process.mjs';

export const AGY_FAST_PLUGIN_NAME = 'agy-fast';
export const AGY_FAST_REPO_URL = 'https://github.com/INK-Q/agy-fast.git';
export const AGY_FAST_MCP_SERVER_NAMES = new Set(['agy-fast_fast', 'fast', 'agy-fast']);
export const AGY_FAST_READ_ONLY_TOOLS = new Set(['batch_search', 'quick_outline', 'read_slices']);
export const AGY_FAST_MUTATING_TOOLS = new Set(['apply_edits', 'run_checks']);
export const AGY_FAST_ALL_TOOLS = new Set([
  ...AGY_FAST_READ_ONLY_TOOLS,
  ...AGY_FAST_MUTATING_TOOLS,
]);

const AGY_FAST_DIRECT_PREFIXES = [
  'mcp__agy-fast_fast__',
  'mcp_agy-fast_fast_',
  'agy-fast_fast/',
  'agy-fast_fast:',
  'agy-fast/',
  'agy-fast:',
];

function parseJsonObjectSafe(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readJsonSafe(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function previewList(items, maxItems = 3) {
  const list = items.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  if (list.length === 0) return '';
  const shown = list.slice(0, maxItems).join(', ');
  return list.length > maxItems ? `${shown} (+${list.length - maxItems})` : shown;
}

/**
 * Unwrap an ACP tool invocation if it targets `agy-fast` (`call_mcp_tool` or direct/prefixed tool name).
 * @param {string} rawName
 * @param {any} rawInput
 * @returns {{
 *   isAgyFast: boolean,
 *   toolName?: string,
 *   readOnly?: boolean,
 *   mutating?: boolean,
 *   args?: Record<string, any>,
 * }}
 */
export function unwrapAgyFastToolInvocation(rawName, rawInput) {
  const name = String(rawName || '').trim();
  const input = parseJsonObjectSafe(rawInput);

  if (name === 'call_mcp_tool') {
    const server = String(input.ServerName || input.serverName || input.server || '').trim();
    const tool = String(input.ToolName || input.toolName || input.tool || '').trim();
    if (!tool) return { isAgyFast: false };
    const matchesServer = AGY_FAST_MCP_SERVER_NAMES.has(server)
      || (server === '' && AGY_FAST_ALL_TOOLS.has(tool));
    if (!matchesServer || !AGY_FAST_ALL_TOOLS.has(tool)) {
      return { isAgyFast: false };
    }
    return {
      isAgyFast: true,
      toolName: tool,
      readOnly: AGY_FAST_READ_ONLY_TOOLS.has(tool),
      mutating: AGY_FAST_MUTATING_TOOLS.has(tool),
      args: parseJsonObjectSafe(input.Arguments ?? input.arguments ?? input.args),
    };
  }

  let bare = name;
  let hadPrefix = false;
  for (const prefix of AGY_FAST_DIRECT_PREFIXES) {
    if (bare.startsWith(prefix)) {
      bare = bare.slice(prefix.length);
      hadPrefix = true;
      break;
    }
  }

  if (AGY_FAST_ALL_TOOLS.has(bare) && (hadPrefix || bare === name)) {
    return {
      isAgyFast: true,
      toolName: bare,
      readOnly: AGY_FAST_READ_ONLY_TOOLS.has(bare),
      mutating: AGY_FAST_MUTATING_TOOLS.has(bare),
      args: input,
    };
  }

  return { isAgyFast: false };
}

/**
 * Build a concise human-readable description & primary target path for an `agy-fast` MCP call.
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @returns {{ description: string, targetPath: string | undefined }}
 */
export function summarizeAgyFastTool(toolName, args = {}) {
  const explicitSummary = typeof args.toolSummary === 'string' && args.toolSummary.trim()
    ? args.toolSummary.trim()
    : typeof args.description === 'string' && args.description.trim()
      ? args.description.trim()
      : '';

  let targetPath;
  let autoDesc = '';

  if (toolName === 'quick_outline') {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    if (typeof paths[0] === 'string' && paths[0].trim()) targetPath = paths[0].trim();
    autoDesc = previewList(paths);
  } else if (toolName === 'batch_search') {
    const queries = Array.isArray(args.queries) ? args.queries : [];
    const firstWithPath = queries.find((q) => typeof q?.path === 'string' && q.path.trim());
    if (firstWithPath) targetPath = firstWithPath.path.trim();
    const patterns = queries.map((q) => (typeof q?.pattern === 'string' ? q.pattern : ''));
    const preview = previewList(patterns, 2);
    if (queries.length > 0) {
      autoDesc = preview ? `${queries.length} queries: ${preview}` : `${queries.length} queries`;
    }
  } else if (toolName === 'read_slices') {
    const outlines = Array.isArray(args.outlines) ? args.outlines : [];
    const slices = Array.isArray(args.slices) ? args.slices : [];
    const lineRanges = Array.isArray(args.lineRanges) ? args.lineRanges : [];
    const rangePaths = lineRanges
      .map((r) => (typeof r === 'string' ? r.split(':')[0]?.trim() : ''))
      .filter(Boolean);
    const slicePaths = slices
      .map((s) => (typeof s?.path === 'string' ? s.path.trim() : ''))
      .filter(Boolean);
    const allPaths = [...outlines, ...slicePaths, ...rangePaths];
    if (typeof allPaths[0] === 'string' && allPaths[0].trim()) targetPath = allPaths[0].trim();
    autoDesc = previewList(allPaths);
  } else if (toolName === 'apply_edits') {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const editPaths = edits.map((e) => (typeof e?.path === 'string' ? e.path.trim() : '')).filter(Boolean);
    if (editPaths[0]) targetPath = editPaths[0];
    const base = previewList(editPaths);
    const verifySuffix = typeof args.verify === 'string' && args.verify.trim() ? ' + verify' : '';
    autoDesc = `${base || (edits.length ? `${edits.length} edits` : '')}${verifySuffix}`.trim();
  } else if (toolName === 'run_checks') {
    const commands = Array.isArray(args.commands) ? args.commands : [];
    const labels = commands.map((c) => {
      if (typeof c?.name === 'string' && c.name.trim()) return c.name.trim();
      if (typeof c?.command === 'string' && c.command.trim()) return c.command.trim();
      return '';
    });
    autoDesc = previewList(labels, 2);
  }

  return {
    description: explicitSummary || autoDesc || toolName,
    targetPath,
  };
}

/**
 * Resolve Gemini / Antigravity CLI home directory (`AGY_ROUTER_HOME_DIR` -> `GEMINI_HOME` -> `~/.gemini`).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGeminiHome(env = process.env) {
  const override = env.AGY_ROUTER_HOME_DIR?.trim() || env.GEMINI_HOME?.trim();
  if (override) return path.resolve(override);
  const home = process.platform === 'win32'
    ? (env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir())
    : (env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir());
  return path.join(home, '.gemini');
}

/**
 * Resolve the global `agy-fast` plugin installation directory.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgyFastPluginDir(env = process.env) {
  return path.join(resolveGeminiHome(env), 'config', 'plugins', AGY_FAST_PLUGIN_NAME);
}

function hasRipgrep(env = process.env) {
  try {
    const res = spawnSync('rg', ['--version'], {
      stdio: 'ignore',
      timeout: 2_000,
      windowsHide: true,
      env,
    });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Inspect local `agy-fast` installation, enablement, tool-loading mode, and optional `rg` availability.
 * @param {{ env?: NodeJS.ProcessEnv, probeRipgrep?: boolean }} [options]
 */
export function inspectAgyFastPlugin(options = {}) {
  const env = options.env || process.env;
  const geminiHome = resolveGeminiHome(env);
  const pluginDir = resolveAgyFastPluginDir(env);
  const manifest = readJsonSafe(path.join(pluginDir, 'plugin.json'));
  const mcpCfg = readJsonSafe(path.join(pluginDir, 'mcp_config.json'));
  const hooksCfg = readJsonSafe(path.join(pluginDir, 'hooks.json'));
  const hasMcpServer = fs.existsSync(path.join(pluginDir, 'dist', 'mcp-server.mjs'));
  const hasSessionStart = fs.existsSync(path.join(pluginDir, 'dist', 'session-start.mjs'));
  const hasRules = fs.existsSync(path.join(pluginDir, 'rules', 'AGENTS.md'));
  const installed = manifest?.name === AGY_FAST_PLUGIN_NAME && hasMcpServer;

  const geminiCfg = readJsonSafe(path.join(geminiHome, 'config', 'config.json'));
  const pluginEntry = geminiCfg?.plugins?.[AGY_FAST_PLUGIN_NAME];
  const enabled = installed ? pluginEntry?.enabled !== false : false;

  const toolsMap = mcpCfg?.mcpServers?.fast?.tools;
  const eagerToolsCount = toolsMap && typeof toolsMap === 'object'
    ? [...AGY_FAST_ALL_TOOLS].filter((t) => toolsMap[t]?.eager === true).length
    : 0;
  const toolLoading = !installed
    ? 'none'
    : eagerToolsCount === AGY_FAST_ALL_TOOLS.size
      ? 'eager'
      : 'lazy';

  const updaterCfg = readJsonSafe(path.join(geminiHome, 'cache', AGY_FAST_PLUGIN_NAME, 'config.json')) || {};
  const autoUpdate = env.AGY_FAST_AUTO_UPDATE?.trim().toLowerCase()
    || (typeof updaterCfg.autoUpdate === 'string' ? updaterCfg.autoUpdate : 'auto');
  const editsFormat = env.AGY_FAST_EDITS_FORMAT?.trim().toLowerCase()
    || (typeof updaterCfg.editsFormat === 'string' ? updaterCfg.editsFormat : 'auto');

  const healthy = Boolean(installed && enabled && hasMcpServer && hasSessionStart && hasRules && hooksCfg);

  return {
    installed,
    enabled,
    healthy,
    pluginDir,
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    toolLoading,
    eagerToolsCount,
    editsFormat,
    autoUpdate,
    hasMcpServer,
    hasSessionStart,
    hasRules,
    hasRipgrep: options.probeRipgrep === false ? null : hasRipgrep(env),
  };
}

/**
 * Ensure `agy-fast` is enabled (and optionally installed with recommended eager/auto flags during `setup`).
 * @param {{ env?: NodeJS.ProcessEnv, installIfMissing?: boolean, dryRun?: boolean }} [options]
 */
export function ensureAgyFastPlugin(options = {}) {
  const env = options.env || process.env;
  const before = inspectAgyFastPlugin({ env, probeRipgrep: false });
  const agyBin = resolveAgyBinary(env);

  if (before.installed) {
    if (!before.enabled && agyBin && !options.dryRun) {
      const spec = buildSpawnSpec(agyBin, ['plugin', 'enable', AGY_FAST_PLUGIN_NAME]);
      spawnSync(spec.command, spec.args, {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env,
      });
      const after = inspectAgyFastPlugin({ env, probeRipgrep: false });
      return { ok: true, action: after.enabled ? 'enabled' : 'unchanged', status: after };
    }
    return { ok: true, action: 'unchanged', status: before };
  }

  if (!options.installIfMissing) {
    return { ok: true, action: 'not-installed', status: before };
  }

  if (options.dryRun) {
    return { ok: true, action: 'dry-run', status: before };
  }

  if (!agyBin) {
    return {
      ok: false,
      action: 'skipped',
      error: '未检测到 agy 可执行文件，跳过安装 agy-fast。',
      status: before,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fast-install-'));
  try {
    const cloneRes = spawnSync('git', ['clone', '--depth', '1', AGY_FAST_REPO_URL, tmpDir], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env,
    });
    if (cloneRes.status !== 0) {
      return {
        ok: false,
        action: 'failed',
        error: `克隆 agy-fast 失败：${(cloneRes.stderr || cloneRes.stdout || cloneRes.error?.message || '').trim()}`,
        status: before,
      };
    }

    const installerPath = path.join(tmpDir, 'scripts', 'install.mjs');
    const installRes = spawnSync(
      process.execPath,
      [installerPath, 'install', '--tool-loading', 'eager', '--edits-format', 'auto'],
      {
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        env,
      },
    );
    const after = inspectAgyFastPlugin({ env, probeRipgrep: false });
    if (installRes.status !== 0 || !after.healthy) {
      return {
        ok: false,
        action: 'failed',
        error: `安装 agy-fast 失败：${(installRes.stderr || installRes.stdout || installRes.error?.message || '').trim()}`,
        status: after,
      };
    }
    return { ok: true, action: 'installed', status: after };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
