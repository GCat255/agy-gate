import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { RouterStore } from '../src/gateway/store.mjs';
import { AgyRunner } from '../src/agy/runner.mjs';
import { createRouterServer } from '../src/gateway/server.mjs';
import {
  buildAutoTitlePrompt,
  extractTitleCandidate,
  isUntitledSessionTitle,
  resolveTitleModelConfig,
} from '../src/agy/session-title.mjs';

test('session-title helpers clean raw outputs, detect placeholders, and select flash-low', () => {
  assert.equal(isUntitledSessionTitle(''), true);
  assert.equal(isUntitledSessionTitle(null), true);
  assert.equal(isUntitledSessionTitle('New session - 2026-11-22'), true);
  assert.equal(isUntitledSessionTitle('子代理功能检查'), false);

  assert.equal(extractTitleCandidate('<think>thinking</think>\n"子代理功能测试。"\nExtra line'), '子代理功能测试');
  assert.equal(extractTitleCandidate('  `Session naming fix`  '), 'Session naming fix');
  assert.equal(extractTitleCandidate('   '), null);

  const cfg = resolveTitleModelConfig({
    sessionModelID: 'gemini-4-hydrogen',
    catalog: { rawIds: new Set(['gemini-4-hydrogen-high', 'gemini-3.8-flash-low']) },
  });
  assert.equal(cfg.modelID, 'gemini-3.8-flash-low');

  const prompt = buildAutoTitlePrompt({ userText: '检查项目进度', assistantText: '已完成检查' });
  assert.match(prompt, /\*\*User\*\*\n检查项目进度/);
  assert.match(prompt, /\*\*Assistant final response\*\*\n已完成检查/);
});

test('agy-runner auto-names untitled sessions after first turn and respects manual renames', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auto-title-'));
  const patches = [];
  const upstreamSessions = new Map([
    ['ses_auto_1', { id: 'ses_auto_1', projectID: 'proj_1', title: '' }],
    ['ses_manual_2', { id: 'ses_manual_2', projectID: 'proj_1', title: '' }],
  ]);

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const m = req.url?.match(/^\/api\/session\/([^?]+)/);
      if (req.method === 'PATCH' && m) {
        const sid = decodeURIComponent(m[1]);
        const body = JSON.parse(bodyStr || '{}');
        patches.push({ sid, body });
        const cur = upstreamSessions.get(sid);
        if (cur && typeof body.title === 'string') cur.title = body.title;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && m) {
        const sid = decodeURIComponent(m[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: upstreamSessions.get(sid) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [...upstreamSessions.values()] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  // Fake agy script handles ACP JSON-RPC 2.0 turns and stateless title generation
  const fakeScript = path.join(dir, 'fake-agy.mjs');
  fs.writeFileSync(
    fakeScript,
    `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split(/\\r?\\n/);
  buf = lines.pop() ?? '';
  for (const l of lines) {
    if (!l.trim()) continue;
    const req = JSON.parse(l);
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1 } }) + '\\n');
    } else if (req.method === 'session/new' || req.method === 'session/resume') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'conv_m' } }) + '\\n');
    } else if (req.method === 'session/set_model' || req.method === 'session/set_config_option') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
    } else if (req.method === 'session/prompt') {
      const promptText = req.params?.prompt?.[0]?.text || '';
      const isTitle = promptText.includes('Assistant final response');
      const text = isTitle ? '子代理自动命名' : '已完成子代理功能核验。';
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'conv_m', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } }) + '\\n');
    }
  }
});
`,
    'utf8',
  );
  const fakeCmd = path.join(dir, 'fake-agy.cmd');
  fs.writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');

  const store = new RouterStore(dir);
  const events = [];
  const sseHub = { broadcast: (ev) => events.push(ev), close() {} };
  const renameSessionTitle = async ({ sessionID, title, signal }) => {
    const res = await fetch(`http://127.0.0.1:${upPort}/api/session/${encodeURIComponent(sessionID)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
      signal,
    });
    assert.equal(res.status, 204);
  };
  const runner = new AgyRunner({
    store,
    sseHub,
    renameSessionTitle,
    env: {
      ...process.env,
      AGY_ROUTER_AGY_BIN: fakeCmd,
      AGY_ROUTER_MAGPIE_BIN: path.join(dir, 'no-magpie.exe'),
      AGY_ROUTER_DISABLE_UI_GUIDANCE: '1',
    },
  });
  const server = createRouterServer({
    upstreamBase: () => `http://127.0.0.1:${upPort}`,
    authHeader: () => '',
    store,
    sseHub,
    agyRunner: runner,
    getAgyCatalogFn: () => ({
      provider: { id: 'agy-cli', name: 'Agy CLI', activation: 'enabled', package: 'agy-cli' },
      models: [],
      variantTargets: new Map(),
      rawIds: new Set(['gemini-4-hydrogen-high', 'gemini-3.8-flash-low']),
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 1. Auto-naming flow for untitled session
    store.setSessionModel('ses_auto_1', { providerID: 'agy-cli', id: 'gemini-4-hydrogen', variant: 'high' });
    const p1 = await fetch(`http://127.0.0.1:${port}/api/session/ses_auto_1/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '帮我检查子代理功能' }),
    });
    assert.equal(p1.status, 200);

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (patches.some((p) => p.sid === 'ses_auto_1' && p.body.title === '子代理自动命名')) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    assert.equal(upstreamSessions.get('ses_auto_1').title, '子代理自动命名');
    assert.equal(store.getSession('ses_auto_1').title, '子代理自动命名');
    assert.equal(events.some((e) => e.type === 'session.renamed' && e.data?.title === '子代理自动命名'), true);

    // 2. Manual rename via PATCH must lock title and prevent auto-naming overwrite
    store.setSessionModel('ses_manual_2', { providerID: 'agy-cli', id: 'gemini-4-hydrogen', variant: 'high' });
    const rPatch = await fetch(`http://127.0.0.1:${port}/api/session/ses_manual_2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '手动命名会话' }),
    });
    assert.equal(rPatch.status, 204);

    const p2 = await fetch(`http://127.0.0.1:${port}/api/session/ses_manual_2/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '测试不会覆盖手动标题' }),
    });
    assert.equal(p2.status, 200);

    const d2 = Date.now() + 4000;
    while (Date.now() < d2) {
      if (store.getMessages('ses_manual_2').some((m) => m.type === 'assistant')) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(upstreamSessions.get('ses_manual_2').title, '手动命名会话');
    assert.equal(patches.filter((p) => p.sid === 'ses_manual_2').length, 1);
  } finally {
    runner.stopAll();
    server.close();
    upstream.close();
    await new Promise((r) => setTimeout(r, 150));
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
});
