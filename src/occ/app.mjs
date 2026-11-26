import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROUTER_BIN_DIR, resolveAgyBinary, resolveRealOpenCode } from '../core/config.mjs';
import { resolveNpmInvocation } from '../core/process.mjs';
import {
  formatSetupReport,
  registerOpenChamberQuotaExtension,
  resolveRouterBinary,
  runSetup,
} from '../cli/setup.mjs';
import { ALT_SCREEN, SPIN, drawScreen, style } from './render.mjs';
import {
  PKG_OPENCODE,
  PKG_OPENCHAMBER,
  baseUrl,
  cmpVer,
  ensureStarted,
  ensureStopped,
  fetchLatestVersions,
  fetchRecentVersions,
  logPath,
  prepareBashEnv,
  previousVersionOf,
  probeQuotaExtension,
  probeStatus,
  quotaAuthState,
  readSettings,
  refreshVersions,
  rememberPrevious,
  resolveWebCli,
  restartRunningService,
  routerBindingState,
  runCapture,
  tail,
  writeSettings,
} from './services.mjs';
import { applyRepoSync, inspectRepoSync } from './sync.mjs';

const IS_WIN = process.platform === 'win32';
const ROUTER_CLI = path.join(ROUTER_BIN_DIR, 'agy-gate.mjs');
const ROUTER_BIN = resolveRouterBinary({ binDir: ROUTER_BIN_DIR, cliEntryPath: ROUTER_CLI });

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
  syncInfo: null,
  syncState: 'pending',
  selected: 0,
  busy: false,
  message: null,
  pick: null,
  renderedLines: 0,
  altActive: false,
};

let spinTimer = null;
let spinFrame = 0;
let spinLabel = '';
let spinStartedAt = 0;

function draw() {
  drawScreen(S, menuRows(), { spinLabel, spinFrame, spinStartedAt });
}

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

function syncSummary() {
  if (S.syncState === 'pending') return '检查中…';
  const info = S.syncInfo;
  if (!info) return '未检查';
  if (info.state === 'no-repo') return '未检测到 Git 仓库';
  if (info.state === 'no-git') return '未检测到 Git';
  if (info.state === 'detached') return '游离 HEAD（请切换分支）';
  if (info.state === 'offline') {
    return info.shortSha ? `${info.branch} (${info.shortSha}) · 离线` : '离线（无法连接 GitHub）';
  }
  if (info.state === 'dirty') {
    return info.behind > 0
      ? `有 ${info.behind} 个更新 · 工作区 ${info.dirtyCount} 处改动`
      : `${info.branch} · 工作区有 ${info.dirtyCount} 处改动`;
  }
  if (info.state === 'diverged') return `${info.branch} · 分叉（+${info.ahead}/-${info.behind}）`;
  if (info.state === 'behind') return `${info.branch} · 有 ${info.behind} 个新提交`;
  if (info.state === 'ahead') return `${info.branch} (${info.shortSha}) · 领先 ${info.ahead}`;
  if (info.state === 'up-to-date') return `${info.branch} (${info.shortSha}) · 已是最新`;
  return info.error || '检查异常';
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
      right: running ? `运行中 · ${baseUrl(S.port)}` : `已停止 · 将启动 ${baseUrl(S.port)}`,
      enabled: !running,
    },
    {
      id: 'stop',
      label: '停止服务',
      right: running ? `实例 ${S.instances.length} · PID ${inst?.pid ?? '?'}` : '已停止 · 无实例',
      enabled: running,
    },
    { id: 'upgrade', label: '升级', right: upgradeSummary(), enabled: true },
    { id: 'sync', label: '同步更新', right: syncSummary(), enabled: true },
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

function quitNow() {
  cleanup();
  process.exit(0);
}

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

async function actionStart() {
  if (S.state === 'running') {
    S.message = `已在运行 ${baseUrl(S.port)}`;
    draw();
    return;
  }
  startSpin('启动服务…');
  const ok = await ensureStarted(S.port);
  await probeStatus(S);
  stopSpin(ok ? style.ok(`已启动 ${baseUrl(S.port)}`) : style.err(`启动超时（30s）。日志：${logPath(S.port)}`));
  draw();
}

async function actionStop() {
  startSpin('停止服务…');
  const ok = await ensureStopped(S);
  stopSpin(ok ? style.ok('服务已停止') : style.err('停止未生效'));
  draw();
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
  const pkg = component === 'opencode' ? PKG_OPENCODE : PKG_OPENCHAMBER;

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
    return { id: v, label: v, right: tags.join(' · '), enabled: v !== local };
  });

  const hint = local ? `当前 ${local}` : '';
  return pick(`选择 ${componentLabel(component)} 版本　${hint}`.trim(), items);
}

async function applyVersion(component, version) {
  const wasRunning = S.state === 'running';
  const before = currentVersionOf(component);
  const label = componentLabel(component);

  if (!(await confirm(`将 ${label} 从 ${before ?? '?'} 换到 ${version}　Enter 确认　Esc 取消`))) {
    S.message = '已取消';
    draw();
    return;
  }

  if (wasRunning) {
    startSpin('停止服务以释放文件…');
    await ensureStopped(S);
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

  await refreshVersions(S);
  const after = currentVersionOf(component);
  const changed = Boolean(after && after !== before);

  if (wasRunning) {
    startSpin('恢复服务…');
    const started = await ensureStarted(S.port);
    await probeStatus(S);
    if (!started) failure = `${failure || ''} 服务恢复失败，日志：${logPath(S.port)}`.trim();
  }

  if (changed) rememberPrevious(component, before);

  let msg;
  if (failure && !changed) msg = style.err(`${label} 未能换到 ${version}：${failure}`);
  else if (failure) msg = style.warn(`${label} 已是 ${after}，但${failure}`);
  else if (changed) msg = style.ok(`${label} 已从 ${before} 换到 ${after}`) + `　回滚：再次选择 ${before}`;
  else msg = style.warn(`${label} 版本未变化（可能该渠道不支持此版本）：仍为 ${after}`);

  stopSpin(msg);
  await fetchLatestVersions(S);
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
  if (!(await confirm(`使用 agy update 更新 agy-cli（当前 ${before ?? '?'}）　Enter 确认　Esc 取消`))) {
    S.message = '已取消';
    draw();
    return;
  }

  if (wasRunning) {
    startSpin('停止服务以释放文件…');
    await ensureStopped(S);
  }

  startSpin('更新 agy-cli…');
  const r = await runCapture(bin, ['update'], 600000);
  let failure = r.ok ? null : tail(r.err || r.out, 4).join(' ');

  await refreshVersions(S);
  const after = S.agyLocal;
  const changed = Boolean(after && after !== before);

  if (wasRunning) {
    startSpin('恢复服务…');
    const started = await ensureStarted(S.port);
    await probeStatus(S);
    if (!started) failure = `${failure || ''} 服务恢复失败，日志：${logPath(S.port)}`.trim();
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

async function restartServiceWithSpinner(stopLabel, startLabel) {
  return restartRunningService(S, (phase) => {
    startSpin(phase === 'stopping' ? stopLabel : startLabel);
  });
}

async function refreshSyncStatus(state, timeoutMs = 5000) {
  const info = await inspectRepoSync({ timeoutMs });
  state.syncInfo = info;
  state.syncState = info.state;
  return info;
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
  const next = readSettings();
  if (toRouter) next.opencodeBinary = ROUTER_BIN;
  else delete next.opencodeBinary;

  let restarted = true;
  if (wasRunning) {
    startSpin('停止服务以切换引擎入口…');
    await ensureStopped(S);
    writeSettings(next);
    S.routerMode = routerBindingState();
    startSpin('重启服务以应用引擎入口…');
    restarted = await ensureStarted(S.port);
    await probeStatus(S);
  } else {
    writeSettings(next);
    S.routerMode = routerBindingState();
  }

  let msg = toRouter
    ? style.ok('已切换为分流网关（OpenCode + agy-cli）')
    : style.ok('已恢复为原生 OpenCode');
  if (wasRunning && !restarted) {
    msg = style.err(`配置已保存，但服务重启超时，日志：${logPath(S.port)}`);
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
  if (!r.ok || !S.quotaAuth.connected) {
    stopSpin(style.err(`授权未完成：${tail(r.err || r.out, 2).join(' ') || '请改用终端执行 agy-gate quota-login'}`));
    draw();
    return;
  }

  const email = S.quotaAuth.email ?? 'Google 账号';
  const extReg = registerOpenChamberQuotaExtension({ env: process.env });
  if (!extReg.ok) {
    stopSpin(style.warn(`已授权 ${email}，但注册 agy-quota 扩展失败：${extReg.error || '请运行 一键配置'}`));
    draw();
    return;
  }

  if (S.state === 'running') {
    let probe = await probeQuotaExtension(S.port);
    if (extReg.action === 'updated' || (probe.reachable && !probe.registered)) {
      const restarted = await restartServiceWithSpinner(
        '停止服务以加载 agy-quota 扩展…',
        '重启服务以应用用量扩展…',
      );
      if (!restarted) {
        stopSpin(style.warn(`已授权 ${email}，但服务重启超时，请手动重启后再在 OP 设置 → 用量查看`));
        draw();
        return;
      }
      probe = await probeQuotaExtension(S.port);
    }

    if (probe.ok) {
      stopSpin(style.ok(`已授权：${email} · OP 已挂载（设置 → 用量 底部「Agy CLI 用量」）`));
    } else if (probe.registered && probe.error) {
      stopSpin(style.warn(`已授权 ${email}，但扩展检测报错：${probe.error}`));
    } else if (probe.reachable && !probe.registered) {
      stopSpin(style.warn(`已授权 ${email}，请重启 OpenChamber 后在设置 → 用量 底部查看「Agy CLI 用量」`));
    } else {
      stopSpin(style.ok(`已授权：${email}（请在 OP 设置 → 用量 底部选择「Agy CLI 用量」并点刷新）`));
    }
  } else {
    stopSpin(style.ok(`已授权：${email}（启动服务后请在 OP 设置 → 用量 底部选择「Agy CLI 用量」）`));
  }
  draw();
}

async function actionSetup() {
  startSpin('配置分流网关、agy-quota 扩展与 OpenChamber MCP…');
  const res = await runSetup({ cliEntryPath: ROUTER_CLI, env: process.env });
  await refreshVersions(S);

  const hostConfigChanged =
    res.steps.engine?.action === 'updated'
    || res.steps.engine?.action === 'removed'
    || res.steps.quotaExtension?.action === 'updated'
    || res.steps.quotaExtension?.action === 'removed';

  let restartFailed = false;
  if (res.ok && hostConfigChanged && S.state === 'running') {
    const restarted = await restartServiceWithSpinner(
      '停止服务以应用最新配置…',
      '重启服务以生效配置…',
    );
    if (!restarted) restartFailed = true;
  }

  if (!res.ok) {
    stopSpin(style.err(`配置未完全成功：${res.warnings[0] || '请运行 agy-gate setup 查看详情'}`));
  } else if (restartFailed) {
    stopSpin(style.warn(`配置已写入，但服务重启超时，日志：${logPath(S.port)}`));
  } else if (res.warnings.length > 0) {
    stopSpin(style.warn(`已写入配置（${res.warnings.length} 项环境提示，可用 agy-gate doctor 检查）`));
  } else if (hostConfigChanged && S.state === 'running') {
    stopSpin(style.ok('已完成一条龙配置并重启 OpenChamber 生效（用量请在底部「Agy CLI 用量」查看）'));
  } else {
    stopSpin(style.ok('已完成一条龙配置（引擎绑定 + agy-quota 扩展 + MCP）'));
  }
  draw();
}

async function actionSync() {
  startSpin('检查 GitHub 仓库更新…');
  const info = await refreshSyncStatus(S, 15000);

  if (!info.ok) {
    stopSpin(style.err(info.error || '无法检查 GitHub 更新'));
    draw();
    return;
  }
  if (info.state === 'dirty') {
    stopSpin(style.warn(`工作区有 ${info.dirtyCount} 处未提交改动，已中止同步以防覆盖`));
    draw();
    return;
  }
  if (info.state === 'diverged') {
    stopSpin(style.warn(`分支 ${info.branch} 与远端分叉（+${info.ahead}/-${info.behind}），请手动合并`));
    draw();
    return;
  }
  if (info.state === 'ahead') {
    stopSpin(style.ok(`分支 ${info.branch} (${info.shortSha}) 领先远端 ${info.ahead} 个提交，无需拉取`));
    draw();
    return;
  }
  if (info.behind === 0) {
    stopSpin(style.ok(`${info.branch} (${info.shortSha}) 已是最新，无需同步`));
    draw();
    return;
  }

  stopSpin(null);
  const topCommit = info.commits[0] ? `（${info.commits[0]}）` : '';
  if (!(await confirm(`发现 ${info.behind} 个新提交${topCommit}，从 GitHub 同步并刷新配置？　Enter 确认　Esc 取消`))) {
    S.message = '已取消';
    draw();
    return;
  }

  const wasRunning = S.state === 'running';
  if (wasRunning) {
    startSpin('停止服务以安全同步代码…');
    await ensureStopped(S);
  }

  startSpin(`正在从 GitHub 拉取 ${info.branch} 并刷新配置…`);
  const syncRes = await applyRepoSync({
    repoRoot: info.repoRoot,
    branch: info.branch,
    installMode: info.installMode,
    env: process.env,
  });

  await Promise.all([refreshVersions(S), refreshSyncStatus(S, 8000)]);

  let restartFailed = false;
  if (wasRunning) {
    startSpin('恢复服务…');
    const started = await ensureStarted(S.port);
    await probeStatus(S);
    if (!started) restartFailed = true;
  }

  if (!syncRes.ok) {
    stopSpin(style.err(`同步未完成：${syncRes.error || '未知错误'}`));
  } else if (restartFailed) {
    stopSpin(style.warn(`已同步到 ${syncRes.afterSha}，但服务恢复失败，日志：${logPath(S.port)}`));
  } else {
    const verSpan = syncRes.beforeSha && syncRes.afterSha && syncRes.beforeSha !== syncRes.afterSha
      ? `${syncRes.beforeSha} → ${syncRes.afterSha}`
      : syncRes.afterSha || '最新';
    stopSpin(style.ok(`已同步（${verSpan}）并刷新配置；建议退出重开 occ 使用新版面板`));
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
    else if (id === 'sync') await actionSync();
    else if (id === 'router') await actionToggleRouter();
    else if (id === 'quota') await actionQuotaAuth();
    else if (id === 'setup') await actionSetup();
  } catch (e) {
    stopSpin(style.err(`操作失败：${String(e?.message || e)}`));
    draw();
  } finally {
    S.busy = false;
    await probeStatus(S);
  }
  return null;
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
  if (running) lines.push(`  实例：${S.instances.length}　地址：${baseUrl(S.port)}`);
  lines.push(`  版本：${upgradeSummary()}`);
  lines.push(`  同步：${syncSummary()}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function helpText() {
  return [
    'occ — OpenChamber 终端启动器',
    '',
    '用法：',
    '  occ                   打开交互菜单',
    '  occ setup             一键配置分流网关、agy-quota 扩展与 OpenChamber MCP',
    '  occ sync [--check]    检查或从 GitHub 同步最新代码并刷新环境配置',
    '',
    '交互菜单：',
    '  启动服务            启动本地服务并显示地址',
    '  停止服务            停止正在运行的实例',
    '  升级                选择组件（opencode / openchamber / agy-cli）进行升级或回滚',
    '  同步更新            从 GitHub 拉取 agy-gate 最新提交并刷新环境配置',
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

async function runOccSyncCli(argv) {
  const checkOnly = argv.includes('--check');
  const asJson = argv.includes('--json');
  const info = await inspectRepoSync({ timeoutMs: 15000, env: process.env });

  if (checkOnly || !info.ok || info.state !== 'behind') {
    const ok = info.ok && (info.state === 'up-to-date' || info.state === 'behind' || info.state === 'ahead');
    if (asJson) {
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    } else if (!info.ok) {
      process.stderr.write(`同步检查失败：${info.error}\n`);
    } else if (info.state === 'dirty') {
      process.stderr.write(`工作区有 ${info.dirtyCount} 处未提交改动，已中止同步。\n`);
    } else if (info.state === 'diverged') {
      process.stderr.write(`分支 ${info.branch} 与远端分叉（+${info.ahead}/-${info.behind}），请手动处理。\n`);
    } else if (info.state === 'ahead') {
      process.stdout.write(`分支 ${info.branch} (${info.shortSha}) 领先远端 ${info.ahead} 个提交，无需拉取。\n`);
    } else if (info.behind === 0) {
      process.stdout.write(`分支 ${info.branch} (${info.shortSha}) 已是最新。\n`);
    } else {
      process.stdout.write(`发现 ${info.behind} 个待同步提交（${info.branch} @ ${info.shortSha}）：\n`);
      for (const c of info.commits) process.stdout.write(`  - ${c}\n`);
    }
    return ok ? 0 : 1;
  }

  await probeStatus(S);
  const wasRunning = S.state === 'running';
  if (wasRunning) {
    await ensureStopped(S);
  }
  const syncRes = await applyRepoSync({
    repoRoot: info.repoRoot,
    branch: info.branch,
    installMode: info.installMode,
    env: process.env,
  });
  let restarted = true;
  if (wasRunning) {
    restarted = await ensureStarted(S.port);
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ inspect: info, sync: syncRes, restarted }, null, 2)}\n`);
  } else if (!syncRes.ok) {
    process.stderr.write(`同步失败：${syncRes.error}\n`);
  } else {
    process.stdout.write(
      `同步完成：${syncRes.beforeSha} → ${syncRes.afterSha}（配置已刷新${wasRunning ? (restarted ? '，OpenChamber 已重启' : '，OpenChamber 重启超时') : ''}）\n`,
    );
  }
  return syncRes.ok && (!wasRunning || restarted) ? 0 : 1;
}

export async function runOccCli(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(helpText());
    return 0;
  }
  if (argv[0] === 'setup') {
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
  if (argv[0] === 'sync') {
    return runOccSyncCli(argv.slice(1));
  }

  await Promise.all([probeStatus(S), fetchLatestVersions(S)]);
  await refreshVersions(S);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await refreshSyncStatus(S, 4000).catch(() => {});
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

  process.on('exit', cleanup);
  process.on('SIGINT', () => quitNow());
  process.on('SIGTERM', () => quitNow());

  draw();
  void refreshSyncStatus(S, 5000).then(() => {
    if (S.altActive && !S.busy && !S.pick) draw();
  }).catch(() => {});
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
