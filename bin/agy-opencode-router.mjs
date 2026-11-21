#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import readline from 'node:readline';
import { parseCliArgs } from '../src/cli-args.mjs';
import { resolveAgyBinary, resolveDataDir, resolveMagpieBinary, resolveRealOpenCode } from '../src/config.mjs';
import { loadMagpieAgyEnv, redactMagpieSummary } from '../src/magpie-env.mjs';
import { getAgyCatalog } from '../src/agy-models.mjs';
import { buildUpstreamAuthHeader, readRealOpenCodeVersion, startInternalOpenCode } from '../src/upstream.mjs';
import { RouterStore } from '../src/store.mjs';
import { SseHub } from '../src/sse-hub.mjs';
import { AgyRunner } from '../src/agy-runner.mjs';
import { createRouterServer } from '../src/server.mjs';
import { createOAuthManager } from '../extensions/agy-quota/service/oauth.js';
import { readAntigravityQuota } from '../extensions/agy-quota/service/quota.js';

function printHelp() {
  process.stdout.write(
    [
      'agy-opencode-router — OpenChamber / OpenCode + agy-cli 分流网关',
      '',
      '用法：',
      '  agy-opencode-router --version',
      '  agy-opencode-router serve [--stdio] [--hostname <host>] [--port <port>]',
      '  agy-opencode-router models',
      '  agy-opencode-router doctor',
      '  agy-opencode-router quota-login',
      '  agy-opencode-router quota-status',
      '  agy-opencode-router quota-logout',
      '  agy-opencode-router --help',
      '',
    ].join('\n'),
  );
}

async function cmdVersion() {
  const realBin = resolveRealOpenCode();
  if (!realBin) {
    process.stderr.write('未找到底层真实 opencode 可执行文件。\n');
    process.exit(1);
  }
  const res = readRealOpenCodeVersion(realBin);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status ?? 1);
}

function cmdModels() {
  const catalog = getAgyCatalog({ forceRefresh: true });
  process.stdout.write(`source: ${catalog.source} (${catalog.models.length} models)\n`);
  for (const m of catalog.models) {
    const variants = Array.isArray(m.variants) && m.variants.length > 0
      ? ` [${m.variants.map((v) => v.id).join(', ')}]`
      : '';
    process.stdout.write(`  ${m.providerID}/${m.id}\t${m.name}${variants}\n`);
  }
}

function cmdDoctor() {
  const realOpenCode = resolveRealOpenCode();
  const agyBin = resolveAgyBinary();
  const useMagpie = process.env.AGY_ROUTER_USE_MAGPIE === '1';
  const magpieBin = useMagpie ? resolveMagpieBinary() : null;
  const magpieEnv = useMagpie ? redactMagpieSummary(loadMagpieAgyEnv({ forceRefresh: true })) : null;
  const ocVer = realOpenCode ? readRealOpenCodeVersion(realOpenCode).stdout?.trim() : null;

  process.stdout.write(
    JSON.stringify(
      {
        dataDir: resolveDataDir(),
        realOpenCode,
        realOpenCodeVersion: ocVer,
        agyBin,
        useMagpie,
        ...(useMagpie ? { magpieBin, magpieEnv } : {}),
      },
      null,
      2,
    ) + '\n',
  );
}

async function cmdServe(opts) {
  const realBin = resolveRealOpenCode();
  if (!realBin) {
    process.stderr.write('错误：未找到真实 opencode 可执行文件，无法启动内部 OpenCode 服务。\n');
    process.exit(1);
  }

  const callerPassword = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD || '';
  const upstreamPassword = callerPassword || crypto.randomBytes(16).toString('hex');
  const upstreamEnv = {
    ...process.env,
    OPENCODE_PASSWORD: upstreamPassword,
    OPENCODE_SERVER_PASSWORD: upstreamPassword,
  };

  const upstream = await startInternalOpenCode({
    binary: realBin,
    hostname: '127.0.0.1',
    stdio: opts.stdio,
    env: upstreamEnv,
  });

  const store = new RouterStore(resolveDataDir());
  const upstreamAuthHeader = () => buildUpstreamAuthHeader(upstreamEnv);
  const clientAuthHeader = () => (callerPassword ? buildUpstreamAuthHeader(process.env) : null);
  const sseHub = new SseHub({
    upstreamUrl: () => upstream.baseUrl,
    authHeader: upstreamAuthHeader,
  });
  const agyRunner = new AgyRunner({ store, sseHub });

  const server = createRouterServer({
    upstreamBase: () => upstream.baseUrl,
    authHeader: upstreamAuthHeader,
    clientAuthHeader,
    store,
    sseHub,
    agyRunner,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    agyRunner.stopAll();
    sseHub.close();
    await new Promise((resolve) => server.close(() => resolve()));
    await upstream.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (opts.stdio) {
    process.stdin.resume();
    process.stdin.on('end', () => void shutdown());
    process.stdin.on('close', () => void shutdown());
  }

  // Also exit if internal opencode dies unexpectedly
  upstream.child.on('exit', () => {
    if (!shuttingDown) void shutdown();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, opts.hostname || '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  const host = opts.hostname || '127.0.0.1';

  sseHub.startUpstream();

  // Emit exact stdout readiness banner expected by OpenChamber lifecycle.ts
  process.stdout.write(`server listening on http://${host}:${actualPort}\n`);
}

function openBrowserUrl(url) {
  if (process.platform === 'win32') {
    const res = spawnSync('rundll32', ['url.dll,FileProtocolHandler', url], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return res.status === 0;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const res = spawnSync(opener, [url], { stdio: 'ignore', windowsHide: true });
  return res.status === 0;
}

async function cmdQuotaLogin() {
  const oauth = createOAuthManager();
  try {
    const started = await oauth.startLogin();
    const authUrl = started?.pendingAuth?.authUrl;
    if (!authUrl) {
      process.stderr.write('无法生成 Google 授权链接。\n');
      process.exit(1);
    }

    const opened = openBrowserUrl(authUrl);
    process.stdout.write(
      [
        opened
          ? '已在默认浏览器打开 Google 授权页，请完成登录授权…'
          : '未能自动打开浏览器，请手动复制下方链接到浏览器打开：',
        authUrl,
        '',
        '等待本地回调完成授权（若浏览器无法回环跳转，也可直接在此粘贴回调 URL 或 code 后按回车）：',
      ].join('\n') + '\n',
    );

    const rl = process.stdin.isTTY || !process.stdin.readableEnded
      ? readline.createInterface({ input: process.stdin })
      : null;

    const manualPromise = new Promise((resolve, reject) => {
      if (!rl) return;
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        oauth.completeManualCallback(trimmed).then(resolve, reject);
      });
    });

    try {
      const record = await Promise.race([oauth.waitForCompletion(), manualPromise]);
      process.stdout.write(`授权成功：${record.email || 'Google 账号'}（凭证已保存至 ${oauth.authFilePath}）\n`);
    } finally {
      rl?.close();
    }
  } finally {
    await oauth.close();
  }
}

async function cmdQuotaStatus() {
  const oauth = createOAuthManager();
  const status = await oauth.getStatus();
  if (!status.connected) {
    process.stdout.write(JSON.stringify({ connected: false, authFilePath: status.authFilePath }, null, 2) + '\n');
    return;
  }
  const quota = await readAntigravityQuota(oauth);
  process.stdout.write(
    JSON.stringify(
      {
        connected: true,
        email: status.email,
        planLabel: quota.planLabel ?? status.planLabel,
        authFilePath: status.authFilePath,
        ok: quota.ok,
        error: quota.error ?? null,
        windows: quota.usage?.windows ?? {},
      },
      null,
      2,
    ) + '\n',
  );
}

async function cmdQuotaLogout() {
  const oauth = createOAuthManager();
  await oauth.clearAuth();
  process.stdout.write(`已清除本地 Agy 用量授权凭证（${oauth.authFilePath}）。\n`);
}

const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.command === 'help') {
  printHelp();
  process.exit(0);
} else if (parsed.command === 'version') {
  await cmdVersion();
} else if (parsed.command === 'models') {
  cmdModels();
} else if (parsed.command === 'doctor') {
  cmdDoctor();
} else if (parsed.command === 'quota-login') {
  await cmdQuotaLogin();
} else if (parsed.command === 'quota-status') {
  await cmdQuotaStatus();
} else if (parsed.command === 'quota-logout') {
  await cmdQuotaLogout();
} else if (parsed.command === 'serve') {
  await cmdServe(parsed);
} else {
  process.stderr.write(`未知子命令：${parsed.raw}\n`);
  printHelp();
  process.exit(1);
}
