import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import {
  ROUTER_BIN_DIR,
  isRouterSelfPath,
  resolveAgyBinary,
  resolveDataDir,
  resolveRealOpenCode,
} from '../core/config.mjs';
import { resolveOpenChamberDataDir, resolveOpenChamberWebRoot } from '../bridge/openchamber.mjs';

const IS_WIN = process.platform === 'win32';
export const PKG_OPENCODE = '@opencode/cli';
export const PKG_OPENCHAMBER = '@openchamber/web';
const STATE_FILE = path.join(resolveDataDir(), 'occ-state.json');

export function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function logPath(port) {
  return path.join(resolveOpenChamberDataDir(process.env), 'logs', `openchamber-${port}.log`);
}

export function resolveWebCli() {
  const webRoot = resolveOpenChamberWebRoot(process.env);
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

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveOpenChamberDataDir(process.env), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function writeSettings(next) {
  const dir = resolveOpenChamberDataDir(process.env);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'settings.json');
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

export function routerBindingState() {
  const configured = typeof readSettings().opencodeBinary === 'string' ? readSettings().opencodeBinary.trim() : '';
  if (isRouterSelfPath(configured)) return 'router';
  if (configured) return 'custom';
  return 'native';
}

export function quotaAuthState() {
  const authPath = path.join(resolveDataDir(), 'quota-auth.json');
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (raw && typeof raw.refreshToken === 'string' && raw.refreshToken.trim()) {
      return { connected: true, email: typeof raw.email === 'string' ? raw.email : null };
    }
  } catch {}
  return { connected: false, email: null };
}

function readState() {
  for (const file of [STATE_FILE, path.join(ROUTER_BIN_DIR, 'state.json')]) {
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

export function rememberPrevious(component, previousVersion) {
  if (!previousVersion) return;
  const state = readState();
  state[component] = { previous: previousVersion, at: Date.now() };
  writeState(state);
}

export function previousVersionOf(component) {
  const entry = readState()[component];
  return entry && typeof entry.previous === 'string' ? entry.previous : null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function firstVersion(text) {
  const m = String(text || '').match(/\d+(?:\.\d+)+/);
  return m ? m[0] : null;
}

export function cmpVer(a, b) {
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

export function tail(text, maxLines = 6) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-maxLines);
}

export function runCapture(file, args, timeoutMs = 20000, env) {
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

export function prepareBashEnv() {
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

export async function probeStatus(state) {
  const webCli = resolveWebCli();
  if (!webCli) {
    state.state = 'unknown';
    state.instances = [];
    state.statusError = '未找到 openchamber CLI';
    return;
  }
  const r = await runCapture(process.execPath, [webCli, 'status', '--json'], 15000);
  try {
    const j = JSON.parse(r.out);
    state.instances = Array.isArray(j.instances) ? j.instances : [];
    state.state = j.state === 'running' || state.instances.length > 0 ? 'running' : 'stopped';
    state.statusError = null;
  } catch {
    state.state = 'unknown';
    state.instances = [];
    state.statusError = tail(r.err || r.out, 3).join(' ') || 'status 解析失败';
  }
  const inst = state.instances.find((i) => Number.isFinite(i?.port));
  if (inst) {
    state.port = inst.port;
  } else {
    const p = readSettings().desktopLocalPort;
    state.port = Number.isFinite(p) && p > 0 && p <= 65535 ? p : 3000;
  }
}

function localOpenchamberVersion() {
  const webRoot = resolveOpenChamberWebRoot(process.env);
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

export async function fetchLatestVersions(state) {
  if (state.latestState === 'ok' && Date.now() - latestAt < 10 * 60 * 1000) return;
  const one = async (name) => {
    const j = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, null, 3000);
    return typeof j?.version === 'string' ? j.version : null;
  };
  const [oc, ob] = await Promise.all([one(PKG_OPENCODE), one(PKG_OPENCHAMBER)]);
  state.latest = { opencode: oc, openchamber: ob };
  state.latestState = oc || ob ? 'ok' : 'offline';
  latestAt = Date.now();
}

export async function fetchRecentVersions(pkg, count = 5) {
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

export async function refreshVersions(state) {
  state.obLocal = localOpenchamberVersion();
  state.ocLocal = await localOpencodeVersion(resolveRealOpenCode(process.env));
  state.agyLocal = await localAgyVersion(resolveAgyBinary(process.env));
  state.routerMode = routerBindingState();
  state.quotaAuth = quotaAuthState();
}

async function ping(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    await fetch(baseUrl(port), { signal: ac.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(port)) return true;
    await sleep(750);
  }
  return ping(port);
}

export async function ensureStarted(port) {
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
  return waitReady(port, 30000);
}

export async function ensureStopped(state) {
  const webCli = resolveWebCli();
  if (!webCli) return false;
  await runCapture(process.execPath, [webCli, 'stop'], 60000);
  await probeStatus(state);
  return state.state !== 'running';
}
