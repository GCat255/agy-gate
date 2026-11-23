import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractUpstreamOnlyMessages,
  formatMessagesAsHandoverContext,
} from '../src/gateway/context-bridge.mjs';
import { RouterStore } from '../src/gateway/store.mjs';
import { SseHub } from '../src/gateway/sse-hub.mjs';
import { AgyRunner } from '../src/agy/runner.mjs';
import { createRouterServer } from '../src/gateway/server.mjs';
import { AGY_PROVIDER_ID, buildAgyProviderInfo, toOpenCodeModelInfo } from '../src/agy/models.mjs';

test('context-bridge trims before latest compaction and enforces char budget', () => {
  const upstream = [
    { id: 'm1', type: 'user', time: { created: 10 }, text: 'old question' },
    { id: 'm2', type: 'assistant', time: { created: 20 }, content: [{ type: 'text', text: 'old reply' }] },
    { id: 'm3', type: 'compaction', status: 'completed', time: { created: 30 }, summary: 'Summary of old chat' },
    { id: 'm4', type: 'user', time: { created: 40 }, text: 'follow up after compaction' },
    { id: 'm_local', type: 'user', time: { created: 50 }, text: 'already local' },
  ];
  const filtered = extractUpstreamOnlyMessages(upstream, [{ id: 'm_local' }]);
  assert.deepEqual(
    filtered.map((m) => m.id),
    ['m3', 'm4'],
  );

  const ctx = formatMessagesAsHandoverContext(filtered);
  assert.ok(ctx.includes('Summary of old chat'));
  assert.ok(ctx.includes('follow up after compaction'));
  assert.ok(!ctx.includes('old question'));
});

test('cross-engine handover, pre-agy /compact, /command, /fork, /revert, and reverse upstream sync work end-to-end', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-handover-e2e-'));
  const mockAgyCmd = path.join(tempDir, process.platform === 'win32' ? 'mock-agy.cmd' : 'mock-agy.sh');
  const mockAgyJs = path.join(tempDir, 'mock-agy.mjs');
  const promptLog = path.join(tempDir, 'prompts.json');

  fs.writeFileSync(
    mockAgyJs,
    [
      "import fs from 'node:fs';",
      "import readline from 'node:readline';",
      `const promptLog = ${JSON.stringify(promptLog)};`,
      "let seq = 0;",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const req = JSON.parse(line);",
      "  if (req.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1 } }));",
      "    return;",
      "  }",
      "  if (req.method === 'session/new' || req.method === 'session/resume') {",
      "    seq += 1;",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: `conv_${seq}` } }));",
      "    return;",
      "  }",
      "  if (req.method === 'session/set_model' || req.method === 'session/set_config_option' || req.method === 'session/set_mode') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }));",
      "    return;",
      "  }",
      "  if (req.method === 'session/prompt') {",
      "    const text = (req.params?.prompt || []).map((b) => b.text || '').join('\\n');",
      "    const list = fs.existsSync(promptLog) ? JSON.parse(fs.readFileSync(promptLog, 'utf8')) : [];",
      "    list.push(text);",
      "    fs.writeFileSync(promptLog, JSON.stringify(list), 'utf8');",
      "    const reply = text.includes('Summarize the following conversation') ? 'Compacted upstream summary.' : 'agy answer';",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: req.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } }));",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } } }));",
      "  }",
      "});",
    ].join('\n'),
    'utf8',
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(mockAgyCmd, `@echo off\r\n"${process.execPath}" "${mockAgyJs}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(mockAgyCmd, `#!/usr/bin/env bash\n"${process.execPath}" "${mockAgyJs}" "$@"\n`, { mode: 0o755 });
  }

  let upstreamMessages = [
    { id: 'msg_up_u1', type: 'user', time: { created: 100 }, text: 'Check architecture decision A?' },
    {
      id: 'msg_up_a1',
      type: 'assistant',
      time: { created: 110, completed: 120 },
      model: { providerID: 'opencode', id: 'model-a' },
      finish: 'stop',
      content: [{ type: 'text', text: 'Model A checked: constraint confirmed.' }],
    },
  ];
  const upstreamSyntheticCalls = [];
  const upstreamRevertCommits = [];

  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    if (req.method === 'GET' && url.pathname === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'evt_u0', created: 1, type: 'server.connected', data: {} })}\n\n`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session/ses_mix/message') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: upstreamMessages }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/ses_mix/synthetic') {
      upstreamSyntheticCalls.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'msg_syn_up', type: 'synthetic', time: { created: 300 }, text: body.text } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/ses_mix/model') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/ses_mix/fork') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'ses_mix_fork', parentID: 'ses_mix', title: 'Forked' } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/ses_mix/revert/stage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { messageID: body.messageID } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/ses_mix/revert/commit') {
      upstreamRevertCommits.push(body);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const store = new RouterStore(tempDir);
  const sseHub = new SseHub({ upstreamUrl: () => upstreamBase, authHeader: () => null });
  const events = [];
  const origBroadcast = sseHub.broadcast.bind(sseHub);
  sseHub.broadcast = (ev) => {
    const env = origBroadcast(ev);
    events.push(env);
    return env;
  };
  const agyRunner = new AgyRunner({
    store,
    sseHub,
    env: {
      ...process.env,
      AGY_ROUTER_AGY_BIN: mockAgyCmd,
      AGY_ROUTER_MAGPIE_BIN: path.join(tempDir, 'no-magpie.exe'),
      AGY_ROUTER_HOME_DIR: tempDir,
      AGY_ROUTER_DISABLE_UI_GUIDANCE: '1',
    },
  });
  const router = createRouterServer({
    upstreamBase: () => upstreamBase,
    authHeader: () => null,
    store,
    sseHub,
    agyRunner,
    getAgyCatalogFn: () => ({
      source: 'mock',
      provider: buildAgyProviderInfo(),
      models: [toOpenCodeModelInfo({ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', variants: ['high'] })],
      variantTargets: new Map([['gemini-4-hydrogen', new Map([['high', 'gemini-4-hydrogen-high'], ['__default__', 'gemini-4-hydrogen-high']])]]),
    }),
  });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  const gwBase = `http://127.0.0.1:${router.address().port}`;

  try {
    // 1. Switch from another model to agy-cli on a session with existing upstream turns
    const sw = await fetch(`${gwBase}/api/session/ses_mix/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { providerID: AGY_PROVIDER_ID, id: 'gemini-4-hydrogen', variant: 'high' } }),
    });
    assert.equal(sw.status, 204);

    // 2. /compact immediately after switching succeeds using upstream history
    const cmpRes = await fetch(`${gwBase}/api/session/ses_mix/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'msg_cmp_up' }),
    });
    assert.equal(cmpRes.status, 200);
    let deadline = Date.now() + 4000;
    while (!events.some((e) => e.type === 'session.compaction.ended') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const ended = events.find((e) => e.type === 'session.compaction.ended');
    assert.equal(ended.data.text, 'Compacted upstream summary.');

    // 3. Follow-up prompt in agy-cli inherits compacted upstream summary automatically
    const idleBefore = events.filter((e) => e.type === 'session.idle').length;
    const p1 = await fetch(`${gwBase}/api/session/ses_mix/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'msg_agy_u1', text: 'Check alternatives?' }),
    });
    assert.equal(p1.status, 200);
    deadline = Date.now() + 4000;
    while (events.filter((e) => e.type === 'session.idle').length < idleBefore + 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // 4. Slash command runs on agy-cli; single message endpoint returns local agy message
    const cmdRes = await fetch(`${gwBase}/api/session/ses_mix/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'review', text: 'latest status' }),
    });
    assert.equal(cmdRes.status, 204);
    deadline = Date.now() + 4000;
    while (events.filter((e) => e.type === 'session.idle').length < idleBefore + 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const singleMsgRes = await (await fetch(`${gwBase}/api/session/ses_mix/message/msg_agy_u1`)).json();
    assert.equal(singleMsgRes.data.text, 'Check alternatives?');

    const loggedPrompts = JSON.parse(fs.readFileSync(promptLog, 'utf8'));
    assert.ok(loggedPrompts[0].includes('Check architecture decision A?'));
    assert.ok(loggedPrompts[1].includes('Compacted upstream summary.') && loggedPrompts[1].includes('Check alternatives?'));
    assert.ok(loggedPrompts[2].includes('/review latest status'));

    // 5. Fork inherits agy-cli activeModel, trimmed history, and pending handover
    const forkRes = await (
      await fetch(`${gwBase}/api/session/ses_mix/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json();
    assert.equal(forkRes.data.model.providerID, AGY_PROVIDER_ID);
    assert.ok(store.getSession('ses_mix_fork')?.pendingHandoverContext?.includes('Check alternatives?'));

    // 6. Revert stage + commit truncates local agy turns and resets ACP conversation handle
    assert.ok(store.getSession('ses_mix')?.agyConversationId);
    await fetch(`${gwBase}/api/session/ses_mix/revert/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg_agy_u1' }),
    });
    const revCommitRes = await fetch(`${gwBase}/api/session/ses_mix/revert/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(revCommitRes.status, 204);
    assert.equal(upstreamRevertCommits.length, 1);
    assert.equal(store.getSession('ses_mix')?.agyConversationId, null);
    assert.equal(store.getMessages('ses_mix').some((m) => m.id === 'msg_agy_u1'), false);

    // 7. Re-create a local agy turn then switch back to OpenCode model -> syncs agy context via upstream /synthetic
    const idleBeforeBack = events.filter((e) => e.type === 'session.idle').length;
    await fetch(`${gwBase}/api/session/ses_mix/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'msg_agy_u2', text: 'New question' }),
    });
    deadline = Date.now() + 4000;
    while (events.filter((e) => e.type === 'session.idle').length < idleBeforeBack + 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const backRes = await fetch(`${gwBase}/api/session/ses_mix/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'opencode', id: 'deepseek-chat' } }),
    });
    assert.equal(backRes.status, 204);
    assert.equal(upstreamSyntheticCalls.length, 1);
    assert.equal(upstreamSyntheticCalls[0].resume, false);
    assert.ok(upstreamSyntheticCalls[0].text.includes('New question'));
  } finally {
    agyRunner.stopAll();
    sseHub.close();
    await new Promise((r) => router.close(r));
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
});
