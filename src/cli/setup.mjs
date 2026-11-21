import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROUTER_BIN_DIR,
  ROUTER_ROOT,
  resolveAgyBinary,
  resolveDataDir,
  resolveRealOpenCode,
} from '../core/config.mjs';
import { resolveNpmInvocation } from '../core/process.mjs';
import { ensureOpenChamberMcpConfig } from '../bridge/mcp.mjs';
import { resolveOpenChamberDataDir, resolveOpenChamberWebRoot } from '../bridge/openchamber.mjs';
import { createOAuthManager } from '../../extensions/agy-quota/service/oauth.js';

const IS_WIN = process.platform === 'win32';
const MODULE_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const DEFAULT_CLI_ENTRY = path.resolve(MODULE_DIR, '..', '..', 'bin', 'agy-gate.mjs');
const QUOTA_EXTENSION_ID = 'agy-quota';

export { resolveNpmInvocation };

function readJsonFile(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Resolve the executable router entrypoint to write into OpenChamber `settings.json`.
 * @param {{ binDir?: string, cliEntryPath?: string }} [options]
 */
export function resolveRouterBinary(options = {}) {
  const binDir = options.binDir || ROUTER_BIN_DIR;
  const preferred = IS_WIN
    ? [
        path.join(binDir, 'agy-gate.cmd'),
        path.join(binDir, 'agy-gate.mjs'),
      ]
    : [
        path.join(binDir, 'agy-gate'),
        path.join(binDir, 'agy-gate.mjs'),
      ];
  for (const candidate of preferred) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return options.cliEntryPath || DEFAULT_CLI_ENTRY;
}

/**
 * Bind or unbind OpenChamber's `opencodeBinary` setting cleanly without disturbing other keys.
 * @param {{ dataDir?: string, routerBinary?: string, restore?: boolean, dryRun?: boolean, env?: NodeJS.ProcessEnv }} [options]
 */
export function registerOpenChamberEngine(options = {}) {
  const env = options.env || process.env;
  const dir = options.dataDir || resolveOpenChamberDataDir(env);
  const settingsPath = path.join(dir, 'settings.json');
  const existing = readJsonFile(settingsPath, {});
  const next = { ...existing };
  const target = options.routerBinary || resolveRouterBinary();

  let action = 'unchanged';
  if (options.restore) {
    if (Object.prototype.hasOwnProperty.call(next, 'opencodeBinary')) {
      delete next.opencodeBinary;
      action = 'removed';
    }
  } else if (next.opencodeBinary !== target) {
    next.opencodeBinary = target;
    action = 'updated';
  }

  if (action !== 'unchanged' && !options.dryRun) {
    writeJsonAtomic(settingsPath, next);
  }

  return {
    ok: true,
    action,
    settingsPath,
    opencodeBinary: options.restore ? null : target,
  };
}

function isAgyQuotaPath(entryPath) {
  const normalized = path.resolve(String(entryPath || '')).replace(/[\\/]+$/, '').toLowerCase();
  return normalized.endsWith(`${path.sep}extensions${path.sep}${QUOTA_EXTENSION_ID}`)
    || normalized.endsWith(`${path.sep}${QUOTA_EXTENSION_ID}`);
}

/**
 * Register (or remove) `extensions/agy-quota` in OpenChamber's `extensions.json`.
 * Preserves all unrelated extensions and existing storage IDs.
 * @param {{ dataDir?: string, extensionDir?: string, remove?: boolean, dryRun?: boolean, env?: NodeJS.ProcessEnv }} [options]
 */
export function registerOpenChamberQuotaExtension(options = {}) {
  const env = options.env || process.env;
  const dir = options.dataDir || resolveOpenChamberDataDir(env);
  const extensionsPath = path.join(dir, 'extensions.json');
  const extensionDir = path.resolve(options.extensionDir || path.join(ROUTER_ROOT, 'extensions', QUOTA_EXTENSION_ID));

  const existing = readJsonFile(extensionsPath, {});
  const currentPaths = Array.isArray(existing.paths) ? existing.paths.filter((p) => typeof p === 'string') : [];
  const nextPaths = currentPaths.filter((p) => !isAgyQuotaPath(p));

  const nextGrants = existing.capabilityGrants && typeof existing.capabilityGrants === 'object'
    ? { ...existing.capabilityGrants }
    : {};
  const nextScopes = existing.capabilityScopes && typeof existing.capabilityScopes === 'object'
    ? { ...existing.capabilityScopes }
    : {};
  const nextStorageIds = existing.storageIds && typeof existing.storageIds === 'object'
    ? { ...existing.storageIds }
    : {};

  if (options.remove) {
    const changed = nextPaths.length !== currentPaths.length
      || Object.prototype.hasOwnProperty.call(nextGrants, QUOTA_EXTENSION_ID)
      || Object.prototype.hasOwnProperty.call(nextScopes, QUOTA_EXTENSION_ID);
    delete nextGrants[QUOTA_EXTENSION_ID];
    delete nextScopes[QUOTA_EXTENSION_ID];
    if (changed && !options.dryRun) {
      writeJsonAtomic(extensionsPath, {
        ...existing,
        paths: nextPaths,
        capabilityGrants: nextGrants,
        capabilityScopes: nextScopes,
        storageIds: nextStorageIds,
      });
    }
    return {
      ok: true,
      action: changed ? 'removed' : 'unchanged',
      extensionsPath,
      extensionDir,
    };
  }

  if (!fs.existsSync(path.join(extensionDir, 'package.json'))) {
    return {
      ok: false,
      action: 'missing',
      extensionsPath,
      extensionDir,
      error: `未找到 agy-quota 扩展目录：${extensionDir}`,
    };
  }

  nextPaths.push(extensionDir);
  nextGrants[QUOTA_EXTENSION_ID] = ['service'];
  nextScopes[QUOTA_EXTENSION_ID] = {
    service: {
      exec: [],
      sockets: [],
      quota: { providers: [] },
    },
  };
  if (typeof nextStorageIds[QUOTA_EXTENSION_ID] !== 'string' || !nextStorageIds[QUOTA_EXTENSION_ID].trim()) {
    nextStorageIds[QUOTA_EXTENSION_ID] = crypto.randomUUID();
  }

  const nextDoc = {
    ...existing,
    paths: nextPaths,
    capabilityGrants: nextGrants,
    capabilityScopes: nextScopes,
    storageIds: nextStorageIds,
  };
  const changed = JSON.stringify(existing) !== JSON.stringify(nextDoc);

  if (changed && !options.dryRun) {
    writeJsonAtomic(extensionsPath, nextDoc);
  }

  return {
    ok: true,
    action: changed ? 'updated' : 'unchanged',
    extensionsPath,
    extensionDir,
  };
}

function runNpmInstall(args, env = process.env) {
  const npm = resolveNpmInvocation(env);
  const res = spawnSync(npm.file, [...npm.prefixArgs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env,
    timeout: 600_000,
  });
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

function parseNodeMajor(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0] || '0', 10) || 0;
}

/**
 * Execute one-stop environment setup for `occ` + `agy-gate`.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cliEntryPath?: string,
 *   routerRoot?: string,
 *   openChamberDataDir?: string,
 *   installDeps?: boolean,
 *   dryRun?: boolean,
 *   uninstall?: boolean,
 *   skipMcp?: boolean,
 *   keepEngine?: boolean,
 * }} [options]
 */
export async function runSetup(options = {}) {
  const env = options.env || process.env;
  const routerRoot = options.routerRoot || ROUTER_ROOT;
  const cliEntryPath = options.cliEntryPath || DEFAULT_CLI_ENTRY;
  const openChamberDataDir = options.openChamberDataDir || resolveOpenChamberDataDir(env);
  const dryRun = Boolean(options.dryRun);
  const uninstall = Boolean(options.uninstall);
  const warnings = [];
  const steps = {};

  if (!uninstall && options.installDeps && !dryRun) {
    const installed = [];
    if (!resolveOpenChamberWebRoot(env)) {
      const r = runNpmInstall(['install', '-g', '@openchamber/web'], env);
      installed.push({ pkg: '@openchamber/web', ...r });
      if (!r.ok) warnings.push(`安装 @openchamber/web 失败：${r.stderr.trim() || r.stdout.trim()}`);
    }
    if (!resolveRealOpenCode(env)) {
      const r = runNpmInstall(['install', '-g', '@opencode/cli'], env);
      installed.push({ pkg: '@opencode/cli', ...r });
      if (!r.ok) warnings.push(`安装 @opencode/cli 失败：${r.stderr.trim() || r.stdout.trim()}`);
    }
    const linkRes = runNpmInstall(['link'], env);
    installed.push({ pkg: 'agy-gate (link)', ...linkRes });
    steps.installDeps = installed;
  }

  if (!options.keepEngine) {
    const routerBinary = resolveRouterBinary({ binDir: path.join(routerRoot, 'bin'), cliEntryPath });
    steps.engine = registerOpenChamberEngine({
      dataDir: openChamberDataDir,
      routerBinary,
      restore: uninstall,
      dryRun,
      env,
    });
  }

  steps.quotaExtension = registerOpenChamberQuotaExtension({
    dataDir: openChamberDataDir,
    extensionDir: path.join(routerRoot, 'extensions', QUOTA_EXTENSION_ID),
    remove: uninstall,
    dryRun,
    env,
  });

  if (!uninstall && !options.skipMcp && !dryRun) {
    steps.mcp = ensureOpenChamberMcpConfig({ cliEntryPath, env });
  } else if (!uninstall && !options.skipMcp && dryRun) {
    steps.mcp = { ok: true, action: 'dry-run' };
  }

  const nodeVersion = process.versions.node;
  const nodeOk = parseNodeMajor(nodeVersion) >= 24;
  if (!nodeOk) {
    warnings.push(`当前 Node.js 版本为 ${nodeVersion}，建议使用 >= 24.0.0`);
  }

  const realOpenCode = resolveRealOpenCode(env);
  const agyBin = resolveAgyBinary(env);
  const openChamberWebRoot = resolveOpenChamberWebRoot(env);

  if (!realOpenCode) warnings.push('未检测到原生 opencode 可执行文件（可运行 npm i -g @opencode/cli 或执行官网安装脚本）');
  if (!openChamberWebRoot) warnings.push('未检测到 @openchamber/web（可运行 npm i -g @openchamber/web）');
  if (!agyBin) warnings.push('未检测到 agy（agy-cli），请先安装 Antigravity CLI 并完成登录');

  let quotaAuth = { connected: false, email: null };
  try {
    const oauth = createOAuthManager();
    const st = await oauth.getStatus();
    quotaAuth = { connected: Boolean(st.connected), email: st.email || null };
  } catch {
    // Ignore quota status read errors
  }

  const checks = {
    nodeVersion,
    nodeOk,
    dataDir: resolveDataDir(env),
    openChamberDataDir,
    openChamberWebRoot,
    realOpenCode,
    agyBin,
    quotaAuth,
  };

  const ok = Boolean(
    (!steps.engine || steps.engine.ok)
    && steps.quotaExtension?.ok
    && (!steps.mcp || steps.mcp.ok),
  );

  return { ok, dryRun, uninstall, steps, checks, warnings };
}

/**
 * Format setup result into concise human-readable text.
 * @param {Awaited<ReturnType<typeof runSetup>>} result
 */
export function formatSetupReport(result) {
  const lines = [
    result.uninstall ? 'agy-gate — 已卸载配置' : 'agy-gate — 环境初始化结果',
    '',
    `  Node.js:          ${result.checks.nodeVersion} ${result.checks.nodeOk ? '✓' : '⚠ (建议 >= 24)'}`,
    `  OpenChamber:      ${result.checks.openChamberWebRoot || '未检测到 ✗'}`,
    `  OpenCode:         ${result.checks.realOpenCode || '未检测到 ✗'}`,
    `  Agy CLI:          ${result.checks.agyBin || '未检测到 ✗'}`,
  ];

  if (result.steps.engine) {
    lines.push(
      `  引擎绑定:         ${result.steps.engine.action} (${result.steps.engine.opencodeBinary || '已恢复默认'})`,
    );
  }
  if (result.steps.quotaExtension) {
    lines.push(
      `  Agy 用量扩展:     ${result.steps.quotaExtension.action} (${result.steps.quotaExtension.extensionDir})`,
    );
  }
  if (result.steps.mcp) {
    lines.push(`  OpenChamber MCP:  ${result.steps.mcp.action || (result.steps.mcp.ok ? 'ready' : 'error')}`);
  }
  lines.push(
    `  Agy 用量授权:     ${result.checks.quotaAuth.connected ? `已授权 (${result.checks.quotaAuth.email || 'Google'})` : '未授权（可运行 occ → Agy 用量授权 或 agy-gate quota-login）'}`,
  );

  if (result.warnings.length > 0) {
    lines.push('', '提示:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }

  lines.push('', '下一步: 运行 `occ` 启动 OpenChamber 并管理升级 / 授权。');
  return `${lines.join('\n')}\n`;
}
