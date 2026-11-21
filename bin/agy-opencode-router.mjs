#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { parseCliArgs } from '../src/cli-args.mjs';
import { resolveAgyBinary, resolveDataDir, resolveMagpieBinary, resolveRealOpenCode } from '../src/config.mjs';
import { loadMagpieAgyEnv, redactMagpieSummary } from '../src/magpie-env.mjs';
import { getAgyCatalog } from '../src/agy-models.mjs';
import { buildUpstreamAuthHeader, readRealOpenCodeVersion, startInternalOpenCode } from '../src/upstream.mjs';
import { RouterStore } from '../src/store.mjs';
import { SseHub } from '../src/sse-hub.mjs';
import { AgyRunner } from '../src/agy-runner.mjs';
import { createRouterServer } from '../src/server.mjs';

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
    process.stdout.write(`  ${m.providerID}/${m.id}\t${m.name}\n`);
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
} else if (parsed.command === 'serve') {
  await cmdServe(parsed);
} else {
  process.stderr.write(`未知子命令：${parsed.raw}\n`);
  printHelp();
  process.exit(1);
}
