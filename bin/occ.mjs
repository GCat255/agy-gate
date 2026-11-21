#!/usr/bin/env node
// occ — OpenChamber 终端启动器
// 零依赖。菜单六项：启动服务 / 停止服务 / 升级 / 引擎入口 / Agy 用量授权 / 一键配置 / 退出。
// 设计原则：命令只表达意图，步骤由工具判断；不可用项灰显并写明原因，不隐藏。

import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROUTER_BIN_DIR,
  resolveAgyBinary,
  resolveDataDir,
  resolveRealOpenCode,
} from '../src/config.mjs';
import {
  resolveOpenChamberDataDir,
  resolveOpenChamberWebRoot,
} from '../src/openchamber-bridge.mjs';
import {
  resolveNpmInvocation,
  resolveRouterBinary,
  runSetup,
} from '../src/setup.mjs';

const IS_WIN = process.platform === 'win32';
const PKG_OPENCODE = '@opencode/cli';
const PKG_OPENCHAMBER = '@openchamber/web';
const TOOL_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const ROUTER_CLI = path.join(TOOL_DIR, 'agy-gate.mjs');
const ROUTER_BIN = resolveRouterBinary({ binDir: ROUTER_BIN_DIR, cliEntryPath: ROUTER_CLI });
const STATE_FILE = path.join(resolveDataDir(), 'occ-state.json');

function resolveWebRoot() {
  return resolveOpenChamberWebRoot(process.env);
}

function resolveWebCli() {
  const webRoot = resolveWebRoot();
  if (!webRoot) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
    const binRel = typeof pkg?.bin === 'string'
      ? pkg.bin
      : typeof pkg?.bin?.openchamber === 'string'
        ? pkg.bin.openchamber
        : null;
    if (binRel) {
      const candidate = path.resolve(webRoot, binRel);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  for (const rel of ['build/bin/cli.js', 'bin/cli.js']) {
    const candidate = path.join(webRoot, ...rel.split('/'));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isRouterPath(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const norm = path.resolve(candidate.trim()).toLowerCase();
  return [
    'agy-gate.cmd',
    'agy-gate.mjs',
    'agy-gate',
    'agy-opencode-router.cmd',
    'agy-opencode-router.mjs',
    'agy-opencode-router',
  ].some((name) => norm.endsWith(`${path.sep}${name}`));
}

function dataDir() {
  return resolveOpenChamberDataDir(process.env);
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'settings.json');
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function routerBindingState() {
  const s = readSettings();
  const configured = typeof s.opencodeBinary === 'string' ? s.opencodeBinary.trim() : '';
  if (isRouterPath(configured)) return 'router';
  if (configured) return 'custom';
  return 'native';
}

function quotaAuthPath() {
  return path.join(resolveDataDir(), 'quota-auth.json');
}

function quotaAuthState() {
  try {
    const raw = JSON.parse(fs.readFileSync(quotaAuthPath(), 'utf8'));
    if (raw && typeof raw.refreshToken === 'string' && raw.refreshToken.trim()) {
      return { connected: true, email: typeof raw.email === 'string' ? raw.email : null };
    }
  } catch {}
  return { connected: false, email: null };
}

/* ---------------------------------------------------------------- 状态记录 */

function readState() {
  for (const file of [STATE_FILE, path.join(TOOL_DIR, 'state.json')]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  return {};
}

function writeState(next) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {}
}

function rememberPrevious(component, previousVersion) {
  if (!previousVersion) return;
  const state = readState();
  state[component] = { previous: previousVersion, at: Date.now() };
  writeState(state);
}

function previousVersionOf(component) {
  const entry = readState()[component];
  return entry && typeof entry.previous === 'string' ? entry.previous : null;
}

/* ---------------------------------------------------------------- 工具 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstVersion(text) {
  const m = String(text || '').match(/\d+(?:\.\d+)+/);
  return m ? m[0] : null;
}

function cmpVer(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = parseInt(pa[i] || '0', 10) || 0;
    const vb = parseInt(pb[i] || '0', 10) || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function runCapture(file, args, timeoutMs = 20000, env) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, cwd: process.cwd(), env: env || process.env });
    } catch (e) {
      finish({ ok: false, code: -1, out: '', err: String(e?.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, out, err: err + String(e?.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code: code ?? -1, out, err });
    });
  });
}

function tail(text, maxLines = 6) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-maxLines);
}

// opencode v2 的 curl 安装器是一个 bash 脚本，它会 spawn `bash` 来跑。
function findBashDirs() {
  try {
    const probe = spawnSync(IS_WIN ? 'where' : 'which', ['bash'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) return [];
  } catch {}

  const bins = [];
  const extras = [];
  const add = (list, p) => {
    try {
      if (p && fs.existsSync(path.join(p, IS_WIN ? 'bash.exe' : 'bash'))) list.push(p);
    } catch {}
  };

  if (IS_WIN) {
    try {
      const git = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
      if (git.status === 0) {
        for (const raw of String(git.stdout || '').split(/\r?\n/)) {
          const p = raw.trim();
          if (!p) continue;
          const root = path.resolve(path.dirname(p), '..');
          add(bins, path.join(root, 'bin'));
          add(extras, path.join(root, 'usr', 'bin'));
        }
      }
    } catch {}
    for (const base of [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git'),
    ]) {
      add(bins, path.join(base, 'bin'));
      add(extras, path.join(base, 'usr', 'bin'));
    }
  }
  return bins.length ? bins : extras;
}

function prepareBashEnv() {
  const dirs = findBashDirs();
  if (!dirs.length) {
    try {
      const probe = spawnSync(IS_WIN ? 'where' : 'which', ['bash'], { encoding: 'utf8', windowsHide: true });
      if (probe.status === 0) return { ok: true, env: process.env };
    } catch {}
    return { ok: false, env: process.env };
  }
  const PATH = process.env.PATH || '';
  return { ok: true, env: { ...process.env, PATH: dirs.join(path.delimiter) + path.delimiter + PATH } };
}

/* ---------------------------------------------------------------- 状态 */

const S = {
  state: 'unknown',
  instances: [],
  port: 3000,
  statusError: null,
  obLocal: null,
  ocLocal: null,
  agyLocal: null,
  routerMode: 'native',
  quotaAuth: { connected: false, email: null },
  latest: { openchamber: null, opencode: null },
  latestState: 'pending',
  selected: 0,
  busy: false,
  message: null,
  pick: null,
  renderedLines: 0,
  altActive: false,
};

function baseUrl() {
  return `http://127.0.0.1:${S.port}`;
}

function logPath() {
  return path.join(dataDir(), 'logs', `openchamber-${S.port}.log`);
}

async function probeStatus() {
  const webCli = resolveWebCli();
  if (!webCli) {
    S.state = 'unknown';
    S.instances = [];
    S.statusError = '未找到 openchamber CLI';
    return;
  }
  const r = await runCapture(process.execPath, [webCli, 'status', '--json'], 15000);
  try {
    const j = JSON.parse(r.out);
    S.instances = Array.isArray(j.instances) ? j.instances : [];
    S.state = j.state === 'running' || S.instances.length > 0 ? 'running' : 'stopped';
    S.statusError = null;
  } catch {
    S.state = 'unknown';
    S.instances = [];
    S.statusError = tail(r.err || r.out, 3).join(' ') || 'status 解析失败';
  }
  const inst = S.instances.find((i) => Number.isFinite(i?.port));
  if (inst) {
    S.port = inst.port;
  } else {
    const p = readSettings().desktopLocalPort;
    S.port = Number.isFinite(p) && p > 0 && p <= 65535 ? p : 3000;
  }
}

function localOpenchamberVersion() {
  const webRoot = resolveWebRoot();
  if (!webRoot) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

async function localOpencodeVersion(bin) {
  if (!bin) return null;
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    const r = await runCapture(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'call', bin, '--version'], 20000);
    return firstVersion(`${r.out} ${r.err}`);
  }
  const r = await runCapture(bin, ['--version'], 20000);
  return firstVersion(`${r.out} ${r.err}`);
}

async function localAgyVersion(bin) {
  if (!bin) return null;
  try {
    const verFile = `${bin}.version`;
    if (fs.existsSync(verFile)) {
      const v = firstVersion(fs.readFileSync(verFile, 'utf8'));
      if (v) return v;
    }
  } catch {}
  const r = await runCapture(bin, ['--version'], 15000);
  return firstVersion(`${r.out} ${r.err}`);
}

let latestAt = 0;
const versionCache = new Map();

async function fetchJson(url, accept, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      cache: 'no-store',
      headers: accept ? { accept } : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestVersions() {
  if (S.latestState === 'ok' && Date.now() - latestAt < 10 * 60 * 1000) return;
  const one = async (name) => {
    const j = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, null, 3000);
    return typeof j?.version === 'string' ? j.version : null;
  };
  const [oc, ob] = await Promise.all([one(PKG_OPENCODE), one(PKG_OPENCHAMBER)]);
  S.latest = { opencode: oc, openchamber: ob };
  S.latestState = oc || ob ? 'ok' : 'offline';
  latestAt = Date.now();
}

async function fetchRecentVersions(pkg, count = 5) {
  const cacheKey = `${pkg}@${count}`;
  if (versionCache.has(cacheKey)) return versionCache.get(cacheKey);
  const doc = await fetchJson(
    `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`,
    'application/vnd.npm.install-v1+json',
    10000,
  );
  if (!doc?.versions) return null;
  const stable = Object.keys(doc.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  stable.sort((a, b) => cmpVer(b, a));
  const result = {
    latest: typeof doc['dist-tags']?.latest === 'string' ? doc['dist-tags'].latest : stable[0] ?? null,
    versions: stable.slice(0, count),
  };
  versionCache.set(cacheKey, result);
  return result;
}

async function refresh() {
  await Promise.all([probeStatus(), fetchLatestVersions()]);
}

async function refreshVersions() {
  S.obLocal = localOpenchamberVersion();
  S.ocLocal = await localOpencodeVersion(resolveRealOpenCode(process.env));
  S.agyLocal = await localAgyVersion(resolveAgyBinary(process.env));
  S.routerMode = routerBindingState();
  S.quotaAuth = quotaAuthState();
}

/* ---------------------------------------------------------------- 动效 */

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinTimer = null;
let spinFrame = 0;
let spinLabel = '';
let spinStartedAt = 0;

function startSpin(label) {
  spinLabel = label;
  spinFrame = 0;
  spinStartedAt = Date.now();
  S.message = null;
  if (!spinTimer) {
    spinTimer = setInterval(() => {
      spinFrame = (spinFrame + 1) % SPIN.length;
      draw();
    }, 90);
  }
}

function stopSpin(message) {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  spinLabel = '';
  S.message = message ?? null;
}

/* ---------------------------------------------------------------- 渲染 */

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ALT_SCREEN = Boolean(process.stdout.isTTY);

const style = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[22m` : s),
  bar: (s) => (COLOR ? `\x1b[7m${s}\x1b[27m` : s),
  ok: (s) => (COLOR ? `\x1b[32m${s}\x1b[39m` : s),
  warn: (s) => (COLOR ? `\x1b[33m${s}\x1b[39m` : s),
  err: (s) => (COLOR ? `\x1b[31m${s}\x1b[39m` : s),
  accent: (s) => (COLOR ? `\x1b[36m${s}\x1b[39m` : s),
};

function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function width(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch.codePointAt(0));
  return w;
}

function columns() {
  return Math.max(30, process.stdout.columns || 80);
}

function height() {
  return Math.max(6, process.stdout.rows || 24);
}

function windowFor(total, index, budget) {
  if (total <= budget) return { start: 0, end: total };
  const start = Math.max(0, Math.min(index - Math.floor(budget / 2), total - budget));
  return { start, end: start + budget };
}

function divider(cols) {
  return style.dim('  ' + '─'.repeat(Math.max(10, cols - 4)));
}

function truncate(text, max) {
  if (width(text) <= max) return text;
  const limit = Math.max(1, max - 1);
  let out = '';
  let w = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function line(left, right, cols) {
  const lw = width(left);
  if (!right) return left;
  if (lw + 4 >= cols) return truncate(left, cols - 1);
  const available = cols - lw - 2;
  const r = width(right) > available ? truncate(right, available) : right;
  const gap = Math.max(1, cols - lw - width(r) - 1);
  return left + ' '.repeat(gap) + r;
}

function upgradeSummary() {
  if (S.latestState !== 'ok') {
    return S.latestState === 'pending' ? '检查中…' : '未检查（离线）';
  }
  const parts = [];
  if (S.latest.opencode && S.ocLocal && cmpVer(S.latest.opencode, S.ocLocal) > 0) {
    parts.push(`opencode ${S.ocLocal}→${S.latest.opencode}`);
  }
  if (S.latest.openchamber && S.obLocal && cmpVer(S.latest.openchamber, S.obLocal) > 0) {
    parts.push(`openchamber ${S.obLocal}→${S.latest.openchamber}`);
  }
  return parts.length ? `有新版：${parts.join(' · ')}` : '已是最新（可回滚）';
}

function menuRows() {
  const running = S.state === 'running';
  const inst = S.instances[0];
  const routerAvailable = fs.existsSync(ROUTER_BIN);
  const routerRight = !routerAvailable
    ? '未找到 agy-gate 垫片'
    : S.routerMode === 'router'
      ? '已启用分流网关（OpenCode + agy-cli）'
      : S.routerMode === 'custom'
        ? '自定义二进制（Enter 切换至分流网关）'
        : '原生 OpenCode（Enter 切换至分流网关）';
  return [
    {
      id: 'start',
      label: '启动服务',
      right: running ? `运行中 · ${baseUrl()}` : `已停止 · 将启动 ${baseUrl()}`,
      enabled: !running,
    },
    {
      id: 'stop',
      label: '停止服务',
      right: running ? `实例 ${S.instances.length} · PID ${inst?.pid ?? '?'}` : '已停止 · 无实例',
      enabled: running,
    },
    { id: 'upgrade', label: '升级', right: upgradeSummary(), enabled: true },
    { id: 'router', label: '引擎入口', right: routerRight, enabled: routerAvailable },
    {
      id: 'quota',
      label: 'Agy 用量授权',
      right: !routerAvailable
        ? '未找到 agy-gate 垫片'
        : S.quotaAuth.connected
          ? `已授权${S.quotaAuth.email ? `（${S.quotaAuth.email}）` : ''} · Enter 解绑`
          : '未授权 · Enter 打开 Google 登录',
      enabled: routerAvailable,
    },
    {
      id: 'setup',
      label: '一键配置',
      right: '绑定分流网关 · 注册 agy-quota 扩展与 MCP',
      enabled: true,
    },
    { id: 'quit', label: '退出', right: '', enabled: true },
  ];
}

function draw() {
  const cols = columns();
  const rows = height();
  const rowWidth = cols - 1;
  const compact = cols < 52;
  const tight = rows < 12;
  const out = [];

  const versions = compact
    ? ''
    : style.dim(`opencode ${S.ocLocal ?? '?'} · agy ${S.agyLocal ?? '?'} · openchamber ${S.obLocal ?? '?'}`);
  out.push(line('  OpenChamber', versions, cols));
  if (!tight) out.push(divider(cols));

  const paintRow = (marker, label, right, enabled, selected) => {
    let text = line(`  ${marker} ${label}`, right, cols);
    const pad = rowWidth - width(text);
    if (pad > 0) text += ' '.repeat(pad);
    if (!enabled) text = style.dim(text);
    if (selected) text = style.bar(text);
    return text;
  };

  const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const fit = (s, max) => (width(plain(s)) > max ? truncate(plain(s), max) : s);

  const unknownLine =
    !S.pick && S.state === 'unknown'
      ? style.err(truncate(`   服务状态未知：${S.statusError ?? ''}`, cols - 1))
      : null;

  let statusLine = null;
  if (spinLabel) {
    const secs = Math.floor((Date.now() - spinStartedAt) / 1000);
    statusLine = '  ' + style.accent(truncate(`${SPIN[spinFrame]} ${spinLabel}${secs >= 1 ? ` ${secs}s` : ''}`, cols - 4));
  } else if (S.message) {
    statusLine = '  ' + fit(S.message, cols - 4);
  }

  const fixed =
    1 +
    (tight ? 0 : 2) +
    (tight ? 0 : 1) +
    (S.pick ? 1 : 0) +
    (statusLine ? 1 : 0) +
    (unknownLine ? 1 : 0);
  const budget = Math.max(1, rows - fixed);

  const items = S.pick ? S.pick.items : menuRows();
  const index = S.pick ? S.pick.index : S.selected;

  if (!S.pick && (!items[S.selected] || !items[S.selected].enabled)) {
    const firstEnabled = items.findIndex((r) => r.enabled);
    if (firstEnabled >= 0) S.selected = firstEnabled;
  }

  const activeIndex = S.pick ? index : S.selected;
  const win = windowFor(items.length, activeIndex, budget);
  const range = items.length > budget ? `　${win.start + 1}-${win.end}/${items.length}` : '';

  if (S.pick) {
    out.push('  ' + style.accent(truncate(`${S.pick.title}${range}`, cols - 4)));
    for (let i = win.start; i < win.end; i++) {
      const it = items[i];
      out.push(paintRow(i === activeIndex ? '›' : ' ', it.label, it.right ?? '', true, i === activeIndex));
    }
    if (!tight) {
      out.push(divider(cols));
      out.push(style.dim(compact ? '  ↑↓ Enter  Esc 返回' : '  ↑↓ 选择   Enter 确认   Esc 返回'));
    }
  } else {
    if (unknownLine) out.push(unknownLine);
    for (let i = win.start; i < win.end; i++) {
      const r = items[i];
      out.push(paintRow(i === activeIndex ? '›' : ' ', r.label, r.right, r.enabled, i === activeIndex));
    }
    if (!tight) {
      out.push(divider(cols));
      out.push(style.dim(compact ? '  ↑↓ Enter  q 退出' : '  ↑↓ 选择   Enter 执行   q 退出'));
    }
  }

  if (statusLine) out.push(statusLine);

  let chunk = '';
  if (ALT_SCREEN) {
    chunk = '\x1b[H' + out.join('\n') + '\x1b[J';
  } else {
    if (S.renderedLines > 0) chunk += `\x1b[${S.renderedLines}A\x1b[0J`;
    chunk += out.join('\n') + '\n';
    S.renderedLines = out.length;
  }
  process.stdout.write(chunk);
}

/* ---------------------------------------------------------------- 键盘 */

const queue = [];
let pending = null;

function pushKey(k) {
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(k);
  } else {
    queue.push(k);
  }
}

function nextKey() {
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((resolve) => {
    pending = resolve;
  });
}

const KEYMAP = new Map([
  ['\u001b[A', 'up'],
  ['\u001bOA', 'up'],
  ['\u001b[B', 'down'],
  ['\u001bOB', 'down'],
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\u0003', 'interrupt'],
  ['\u001b', 'escape'],
  ['k', 'up'],
  ['j', 'down'],
  ['q', 'quit'],
]);

function startKeys() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const key = KEYMAP.get(data);
    if (key) pushKey(key);
  });
}

/* ---------------------------------------------------------------- 交互 */

async function confirm(prompt) {
  S.message = prompt;
  draw();
  for (;;) {
    const k = await nextKey();
    if (k === 'enter') return true;
    if (k === 'interrupt') quitNow();
    if (k === 'escape' || k === 'quit') return false;
  }
}

async function pick(title, items) {
  const saved = S.pick;
  S.pick = { title, items, index: Math.max(0, items.findIndex((i) => i.enabled !== false)) };
  S.message = null;
  draw();
  try {
    for (;;) {
      const k = await nextKey();
      if (k === 'interrupt') quitNow();
      if (k === 'escape' || k === 'quit') return null;
      if (k === 'up' || k === 'down') {
        const step = k === 'up' ? -1 : 1;
        let i = S.pick.index;
        for (let n = 0; n < S.pick.items.length; n++) {
          i = (i + step + S.pick.items.length) % S.pick.items.length;
          if (S.pick.items[i].enabled !== false) break;
        }
        S.pick.index = i;
        draw();
        continue;
      }
      if (k === 'enter') {
        const item = S.pick.items[S.pick.index];
        if (!item || item.enabled === false) continue;
        return item.id;
      }
    }
  } finally {
    S.pick = saved;
  }
}

/* ---------------------------------------------------------------- 动作 */

async function ping() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    await fetch(baseUrl(), { signal: ac.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping()) return true;
    await sleep(750);
  }
  return ping();
}

async function ensureStarted() {
  const webCli = resolveWebCli();
  if (!webCli) return false;
  const child = spawn(process.execPath, [webCli, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: process.cwd(),
  });
  child.on('error', () => {});
  child.unref();
  return waitReady(30000);
}

async function ensureStopped() {
  const webCli = resolveWebCli();
  if (!webCli) return false;
  await runCapture(process.execPath, [webCli, 'stop'], 60000);
  await probeStatus();
  return S.state !== 'running';
}

async function actionStart() {
  if (S.state === 'running') {
    S.message = `已在运行 ${baseUrl()}`;
    draw();
    return;
  }
  startSpin('启动服务…');
  const ok = await ensureStarted();
  await probeStatus();
  stopSpin(ok ? style.ok(`已启动 ${baseUrl()}`) : style.err(`启动超时（30s）。日志：${logPath()}`));
  draw();
}

async function actionStop() {
  startSpin('停止服务…');
  const ok = await ensureStopped();
  stopSpin(ok ? style.ok('服务已停止') : style.err('停止未生效'));
  draw();
}

function componentLabel(component) {
  if (component === 'opencode') return 'opencode';
  if (component === 'agy') return 'agy-cli';
  return 'openchamber';
}

function currentVersionOf(component) {
  if (component === 'opencode') return S.ocLocal;
  if (component === 'agy') return S.agyLocal;
  return S.obLocal;
}

function packageOf(component) {
  return component === 'opencode' ? PKG_OPENCODE : PKG_OPENCHAMBER;
}

async function chooseComponent() {
  const rows = [];
  for (const component of ['opencode', 'openchamber']) {
    const local = currentVersionOf(component);
    const latest = S.latest[component];
    let right;
    if (!latest) right = `当前 ${local ?? '?'} · 版本未获取（离线）`;
    else if (local && cmpVer(latest, local) > 0) right = `当前 ${local} · 最新 ${latest}`;
    else right = `当前 ${local ?? '?'} · 已是最新`;
    const prev = previousVersionOf(component);
    if (prev && prev !== local) right += ` · 可回滚 ${prev}`;
    rows.push({ id: component, label: componentLabel(component), right });
  }
  const agyBin = resolveAgyBinary(process.env);
  rows.push({
    id: 'agy',
    label: 'agy-cli',
    right: agyBin ? `当前 ${S.agyLocal ?? '?'} · 通过 agy update 升级` : '未找到 agy',
    enabled: Boolean(agyBin),
  });
  return pick('选择要调整的组件', rows);
}

async function chooseVersion(component) {
  const local = currentVersionOf(component);
  const pkg = packageOf(component);

  startSpin(`获取 ${componentLabel(component)} 最近版本…`);
  const recent = await fetchRecentVersions(pkg, 5);
  stopSpin(null);
  if (!recent || !recent.versions.length) {
    S.message = style.err('取不到版本列表（网络不可用或 registry 无响应）');
    draw();
    return null;
  }

  const prev = previousVersionOf(component);
  const marked = new Map();
  for (const v of recent.versions) marked.set(v, []);
  if (local && !marked.has(local)) marked.set(local, []);
  if (prev && !marked.has(prev)) marked.set(prev, []);

  const all = [...marked.keys()].sort((a, b) => cmpVer(b, a));
  const items = all.map((v) => {
    const tags = [];
    if (v === recent.latest) tags.push('最新');
    if (v === local) tags.push('当前');
    if (prev && v === prev && v !== local) tags.push('↩ 上次');
    if (local && cmpVer(v, local) > 0) tags.push('↑ 升级');
    if (local && cmpVer(v, local) < 0) tags.push('↓ 回滚');
    return {
      id: v,
      label: v,
      right: tags.join(' · '),
      enabled: v !== local,
    };
  });

  const hint = local ? `当前 ${local}` : '';
  return pick(`选择 ${componentLabel(component)} 版本　${hint}`.trim(), items);
}

async function applyVersion(component, version) {
  const wasRunning = S.state === 'running';
  const before = currentVersionOf(component);
  const label = componentLabel(component);

  const ok = await confirm(
    `将 ${label} 从 ${before ?? '?'} 换到 ${version}　Enter 确认　Esc 取消`,
  );
  if (!ok) {
    S.message = '已取消';
    draw();
    return;
  }

  if (wasRunning) {
    startSpin('停止服务以释放文件…');
    await ensureStopped();
  }

  let failure = null;
  if (component === 'opencode') {
    startSpin(`升级 opencode 到 ${version}…`);
    const bin = resolveRealOpenCode(process.env);
    if (!bin) {
      failure = '未找到 opencode 可执行文件';
    } else {
      const bash = prepareBashEnv();
      if (!bash.ok) {
        failure = '需要 bash：opencode 的 curl 安装器要用 bash，本机 PATH 上没有。装 Git for Windows 后重试（官方 issue #50886）';
      } else {
        const r = await runCapture(bin, ['upgrade', version], 600000, bash.env);
        if (!r.ok) failure = tail(r.err || r.out, 4).join(' ');
      }
    }
  } else {
    startSpin(`安装 @openchamber/web@${version}…`);
    const npm = resolveNpmInvocation(process.env);
    const r = await runCapture(npm.file, [...npm.prefixArgs, 'install', '-g', `${PKG_OPENCHAMBER}@${version}`], 600000);
    if (!r.ok) failure = tail(r.err || r.out, 4).join(' ');
  }

  await refreshVersions();
  const after = currentVersionOf(component);
  const changed = Boolean(after && after !== before);

  if (wasRunning) {
    startSpin('恢复服务…');
    const started = await ensureStarted();
    await probeStatus();
    if (!started) failure = `${failure || ''} 服务恢复失败，日志：${logPath()}`.trim();
  }

  if (changed) rememberPrevious(component, before);

  let msg;
  if (failure && !changed) msg = style.err(`${label} 未能换到 ${version}：${failure}`);
  else if (failure) msg = style.warn(`${label} 已是 ${after}，但${failure}`);
  else if (changed) msg = style.ok(`${label} 已从 ${before} 换到 ${after}`) + `　回滚：再次选择 ${before}`;
  else msg = style.warn(`${label} 版本未变化（可能该渠道不支持此版本）：仍为 ${after}`);

  stopSpin(msg);
  await fetchLatestVersions();
  draw();
}

async function upgradeAgyCli() {
  const bin = resolveAgyBinary(process.env);
  if (!bin) {
    S.message = style.err('未找到 agy');
    draw();
    return;
  }

  const wasRunning = S.state === 'running';
  const before = S.agyLocal;
  const ok = await confirm(`使用 agy update 更新 agy-cli（当前 ${before ?? '?'}）　Enter 确认　Esc 取消`);
  if (!ok) {
    S.message = '已取消';
    draw();
    return;
  }

  if (wasRunning) {
    startSpin('停止服务以释放文件…');
    await ensureStopped();
  }

  startSpin('更新 agy-cli…');
  const r = await runCapture(bin, ['update'], 600000);
  let failure = r.ok ? null : tail(r.err || r.out, 4).join(' ');

  await refreshVersions();
  const after = S.agyLocal;
  const changed = Boolean(after && after !== before);

  if (wasRunning) {
    startSpin('恢复服务…');
    const started = await ensureStarted();
    await probeStatus();
    if (!started) failure = `${failure || ''} 服务恢复失败，日志：${logPath()}`.trim();
  }

  if (changed) rememberPrevious('agy', before);

  let msg;
  if (failure && !changed) msg = style.err(`agy-cli 更新失败：${failure}`);
  else if (failure) msg = style.warn(`agy-cli 已是 ${after}，但${failure}`);
  else if (changed) msg = style.ok(`agy-cli 已从 ${before} 更新到 ${after}`);
  else msg = style.ok(`agy-cli 已是最新（${after ?? '?'}）`);

  stopSpin(msg);
  draw();
}

async function actionToggleRouter() {
  if (!fs.existsSync(ROUTER_BIN)) {
    S.message = style.err(`未找到分流网关：${ROUTER_BIN}`);
    draw();
    return;
  }

  const toRouter = S.routerMode !== 'router';
  const promptText = toRouter
    ? '将 OpenChamber 引擎入口切换为分流网关（OpenCode + agy-cli）　Enter 确认　Esc 取消'
    : '将 OpenChamber 引擎入口恢复为原生 OpenCode　Enter 确认　Esc 取消';
  if (!(await confirm(promptText))) {
    S.message = '已取消';
    draw();
    return;
  }

  const wasRunning = S.state === 'running';
  if (wasRunning) {
    startSpin('停止服务以切换引擎入口…');
    await ensureStopped();
  }

  const next = readSettings();
  if (toRouter) {
    next.opencodeBinary = ROUTER_BIN;
  } else {
    delete next.opencodeBinary;
  }
  writeSettings(next);
  S.routerMode = routerBindingState();

  let msg = toRouter
    ? style.ok('已切换为分流网关（OpenCode + agy-cli）')
    : style.ok('已恢复为原生 OpenCode');

  if (wasRunning) {
    startSpin('重启服务以应用引擎入口…');
    const started = await ensureStarted();
    await probeStatus();
    if (!started) msg = style.err(`配置已保存，但服务重启超时，日志：${logPath()}`);
  }

  stopSpin(msg);
  draw();
}

function buildRouterInvocation(subArgs) {
  if (IS_WIN && /\.cmd$/i.test(ROUTER_BIN)) {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'call', ROUTER_BIN, ...subArgs] };
  }
  if (/\.mjs$/i.test(ROUTER_BIN)) {
    return { cmd: process.execPath, args: [ROUTER_BIN, ...subArgs] };
  }
  return { cmd: ROUTER_BIN, args: subArgs };
}

async function actionQuotaAuth() {
  if (!fs.existsSync(ROUTER_BIN)) {
    S.message = style.err(`未找到 agy-gate：${ROUTER_BIN}`);
    draw();
    return;
  }

  S.quotaAuth = quotaAuthState();
  if (S.quotaAuth.connected) {
    const label = S.quotaAuth.email ? `（${S.quotaAuth.email}）` : '';
    if (!(await confirm(`解除 Agy 用量 Google 授权${label}　Enter 确认　Esc 取消`))) {
      S.message = '已取消';
      draw();
      return;
    }
    startSpin('清除 Agy 用量授权…');
    const inv = buildRouterInvocation(['quota-logout']);
    const r = await runCapture(inv.cmd, inv.args, 15000);
    S.quotaAuth = quotaAuthState();
    stopSpin(r.ok ? style.ok('已解除 Agy 用量授权') : style.err(`解绑失败：${tail(r.err || r.out, 2).join(' ')}`));
    draw();
    return;
  }

  if (!(await confirm('将在浏览器打开 Google 授权页（仅用于读取 Agy 用量）　Enter 继续　Esc 取消'))) {
    S.message = '已取消';
    draw();
    return;
  }
  startSpin('等待浏览器完成 Google 授权（最长 3 分钟）…');
  const inv = buildRouterInvocation(['quota-login']);
  const r = await runCapture(inv.cmd, inv.args, 180000);
  S.quotaAuth = quotaAuthState();
  if (r.ok && S.quotaAuth.connected) {
    stopSpin(style.ok(`已授权：${S.quotaAuth.email ?? 'Google 账号'}（可在 OpenChamber 设置 → 用量刷新查看）`));
  } else {
    stopSpin(style.err(`授权未完成：${tail(r.err || r.out, 2).join(' ') || '请改用终端执行 agy-gate quota-login'}`));
  }
  draw();
}

async function actionSetup() {
  startSpin('配置分流网关、agy-quota 扩展与 OpenChamber MCP…');
  const res = await runSetup({ cliEntryPath: ROUTER_CLI, env: process.env });
  await refreshVersions();
  if (!res.ok) {
    stopSpin(style.err(`配置未完全成功：${res.warnings[0] || '请运行 agy-gate setup 查看详情'}`));
  } else if (res.warnings.length > 0) {
    stopSpin(style.warn(`已写入配置（${res.warnings.length} 项环境提示，可用 agy-gate doctor 检查）`));
  } else {
    stopSpin(style.ok('已完成一条龙配置（引擎绑定 + agy-quota 扩展 + MCP）'));
  }
  draw();
}

async function actionUpgrade() {
  const component = await chooseComponent();
  if (!component) {
    S.message = null;
    draw();
    return;
  }
  if (component === 'agy') {
    await upgradeAgyCli();
    return;
  }
  const version = await chooseVersion(component);
  if (!version) {
    S.message = null;
    draw();
    return;
  }
  await applyVersion(component, version);
}

async function runRow(id) {
  if (id === 'quit') return 'quit';
  S.busy = true;
  try {
    if (id === 'start') await actionStart();
    else if (id === 'stop') await actionStop();
    else if (id === 'upgrade') await actionUpgrade();
    else if (id === 'router') await actionToggleRouter();
    else if (id === 'quota') await actionQuotaAuth();
    else if (id === 'setup') await actionSetup();
  } catch (e) {
    stopSpin(style.err(`操作失败：${String(e?.message || e)}`));
    draw();
  } finally {
    S.busy = false;
    await probeStatus();
  }
  return null;
}

/* ---------------------------------------------------------------- 主流程 */

function quitNow() {
  cleanup();
  process.exit(0);
}

function cleanup() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  try {
    process.stdout.write('\x1b[?25h' + (S.altActive ? '\x1b[?1049l' : ''));
    S.altActive = false;
  } catch {}
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  try {
    process.stdin.pause();
  } catch {}
}

function plainStatus() {
  const running = S.state === 'running';
  const engineLabel = S.routerMode === 'router'
    ? '分流网关（OpenCode + agy-cli）'
    : S.routerMode === 'custom'
      ? `自定义（${readSettings().opencodeBinary}）`
      : '原生 OpenCode';
  const lines = [
    'OpenChamber',
    `  opencode ${S.ocLocal ?? '?'} · agy ${S.agyLocal ?? '?'} · openchamber ${S.obLocal ?? '?'}`,
    `  引擎：${engineLabel}`,
    `  用量：${S.quotaAuth.connected ? `已授权${S.quotaAuth.email ? `（${S.quotaAuth.email}）` : ''}` : '未授权'}`,
    `  服务：${running ? '运行中' : S.state === 'unknown' ? '状态未知' : '已停止'}`,
  ];
  if (running) lines.push(`  实例：${S.instances.length}　地址：${baseUrl()}`);
  const summary = upgradeSummary();
  lines.push(`  版本：${summary}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function helpText() {
  return [
    'occ — OpenChamber 终端启动器',
    '',
    '用法：',
    '  occ           打开交互菜单',
    '  occ setup     一键配置分流网关、agy-quota 扩展与 OpenChamber MCP',
    '',
    '交互菜单：',
    '  启动服务            启动本地服务并显示地址',
    '  停止服务            停止正在运行的实例',
    '  升级                选择组件（opencode / openchamber / agy-cli）进行升级或回滚',
    '  引擎入口            在原生 OpenCode 与 agy-gate 分流网关间切换',
    '  Agy 用量授权        为 Agy CLI 用量扩展完成或解除只读 Google OAuth 授权',
    '  一键配置            绑定分流网关、注册 agy-quota 扩展与 openchamber MCP',
    '  退出                等同于 q',
    '',
    '不会自动打开浏览器；地址显示在菜单里，自行用浏览器或任务栏的 OpenChamber 打开。',
    '非交互环境（管道）下不进菜单，直接打印状态。',
    '',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(helpText());
    return 0;
  }
  if (argv[0] === 'setup') {
    const { formatSetupReport } = await import('../src/setup.mjs');
    const result = await runSetup({
      cliEntryPath: ROUTER_CLI,
      installDeps: argv.includes('--install-deps'),
      dryRun: argv.includes('--dry-run'),
      uninstall: argv.includes('--uninstall'),
      skipMcp: argv.includes('--no-mcp'),
      keepEngine: argv.includes('--keep-engine'),
    });
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatSetupReport(result));
    return result.ok ? 0 : 1;
  }

  await refresh();
  await refreshVersions();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    plainStatus();
    return 0;
  }

  if (!resolveWebCli()) {
    process.stdout.write('未找到 @openchamber/web。\n请先运行 `occ setup --install-deps` 或 `npm install -g @openchamber/web`。\n');
    return 1;
  }

  try {
    startKeys();
  } catch (e) {
    process.stdout.write(`终端不支持交互模式（${String(e?.message || e)}），改为打印状态：\n\n`);
    plainStatus();
    return 0;
  }

  if (ALT_SCREEN) {
    process.stdout.write('\x1b[?1049h');
    S.altActive = true;
  }
  process.stdout.write('\x1b[?25l');
  process.stdout.on('resize', () => {
    if (S.altActive) draw();
  });

  draw();
  for (;;) {
    const key = await nextKey();
    if (key === 'interrupt' || key === 'quit') break;
    if (S.busy) continue;

    const rows = menuRows();
    if (key === 'up' || key === 'down') {
      S.message = null;
      const step = key === 'up' ? -1 : 1;
      let i = S.selected;
      for (let n = 0; n < rows.length; n++) {
        i = (i + step + rows.length) % rows.length;
        if (rows[i].enabled) break;
      }
      S.selected = i;
      draw();
      continue;
    }

    if (key === 'enter') {
      const row = rows[S.selected];
      if (!row || !row.enabled) {
        S.message = '该项当前不可用';
        draw();
        continue;
      }
      S.message = null;
      const stop = await runRow(row.id);
      if (stop === 'quit') break;
      draw();
    }
  }

  cleanup();
  return 0;
}

process.on('exit', cleanup);
process.on('SIGINT', () => quitNow());
process.on('SIGTERM', () => quitNow());

main()
  .then((code) => {
    cleanup();
    process.exit(code ?? 0);
  })
  .catch((e) => {
    cleanup();
    process.stdout.write(`\nocc 出错：${String(e?.stack || e?.message || e)}\n`);
    process.exit(1);
  });
