import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStore } from '../src/store.mjs';
import { SseHub } from '../src/sse-hub.mjs';
import { AgyRunner } from '../src/agy-runner.mjs';
import { createRouterServer } from '../src/server.mjs';
import { AGY_PROVIDER_ID, buildAgyProviderInfo, toOpenCodeModelInfo } from '../src/agy-models.mjs';

test('router server injects agy-cli models, splits prompt traffic, and streams merged SSE', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-router-e2e-'));
  const mockAgyCmd = path.join(tempDir, process.platform === 'win32' ? 'mock-agy.cmd' : 'mock-agy.sh');
  const mockAgyJs = path.join(tempDir, 'mock-agy.mjs');

  fs.writeFileSync(
    mockAgyJs,
    [
      "const args = process.argv.slice(2);",
      "const conv = 'conv_mock_1';",
      "console.log(JSON.stringify({ event: 'init', conversation_id: conv, init: { model: 'gemini-4-hydrogen-high' } }));",
      "console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hi from ' } }));",
      "console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'agy', usage: { input_tokens: 5, output_tokens: 3 } } }));",
      "console.log(JSON.stringify({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'hi from agy' } }));",
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    fs.writeFileSync(mockAgyCmd, `@echo off\r\n"${process.execPath}" "${mockAgyJs}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(mockAgyCmd, `#!/usr/bin/env bash\n"${process.execPath}" "${mockAgyJs}" "$@"\n`, { mode: 0o755 });
  }

  const upstreamPrompts = [];
  const upstreamSseClients = new Set();

  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'GET' && url.pathname === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'evt_up_0', created: 1, type: 'server.connected', data: {} })}\n\n`);
      upstreamSseClients.add(res);
      req.on('close', () => upstreamSseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/provider') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ location: { directory: 'E:/proj' }, data: [{ id: 'opencode', name: 'OpenCode', activation: 'enabled', package: 'opencode' }] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/model') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ location: { directory: 'E:/proj' }, data: [{ id: 'gpt-5', modelID: 'gpt-5', providerID: 'opencode', name: 'GPT-5', type: 'chat' }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      const parsed = JSON.parse(bodyText || '{}');
      assert.equal(parsed.model, undefined, 'agy-cli virtual model should be stripped before upstream session.create');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'ses_test', projectID: 'global', location: { directory: 'E:/proj' }, time: { created: 100, updated: 100 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session/ses_test/model') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session/ses_test/prompt') {
      upstreamPrompts.push(JSON.parse(bodyText || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'msg_oc', type: 'user', time: { created: 200 }, delivery: 'queue', payload: {} } }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/session/ses_test/message') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: 'msg_oc', type: 'user', time: { created: 150 }, text: 'hello opencode' }],
        cursor: {},
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/session/active') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: {} }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upPort}`;

  const store = new RouterStore(tempDir);
  const sseHub = new SseHub({ upstreamUrl: () => upstreamBase, authHeader: () => null });
  const agyRunner = new AgyRunner({
    store,
    sseHub,
    env: { ...process.env, AGY_ROUTER_AGY_BIN: mockAgyCmd, AGY_ROUTER_MAGPIE_BIN: path.join(tempDir, 'no-magpie.exe') },
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
      models: [toOpenCodeModelInfo({ id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' })],
    }),
  });

  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const gwPort = router.address().port;
  const gwBase = `http://127.0.0.1:${gwPort}`;
  sseHub.startUpstream();

  try {
    // 1. Check provider & model injection
    const providers = await (await fetch(`${gwBase}/api/provider`)).json();
    assert.deepEqual(providers.data.map((p) => p.id), ['opencode', AGY_PROVIDER_ID]);

    const models = await (await fetch(`${gwBase}/api/model?types=chat`)).json();
    assert.deepEqual(models.data.map((m) => `${m.providerID}/${m.id}`), [
      'opencode/gpt-5',
      'agy-cli/gemini-4-hydrogen-high',
    ]);

    // 2. Subscribe to SSE
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${gwBase}/api/event`, { signal: sseAbort.signal });
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const received = [];
    const pump = (async () => {
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          if (p.startsWith('data: ')) {
            received.push(JSON.parse(p.slice(6)));
          }
        }
      }
    })().catch(() => {});

    // 3. Create session with agy-cli model
    const created = await (
      await fetch(`${gwBase}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
        body: JSON.stringify({ model: { providerID: AGY_PROVIDER_ID, id: 'gemini-4-hydrogen-high' } }),
      })
    ).json();
    assert.equal(created.data.model.providerID, AGY_PROVIDER_ID);

    // 4. Send prompt -> routed to mock agy-cli (upstreamPrompts stays empty!)
    const promptRes = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_u1', text: 'hello agy' }),
    });
    assert.equal(promptRes.status, 200);
    assert.equal(upstreamPrompts.length, 0);

    // Wait for session.idle from mock agy
    const deadline = Date.now() + 5000;
    while (!received.some((e) => e.type === 'session.idle') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(
      received.some((e) => e.type === 'session.text.delta' && e.data.delta === 'hi from '),
      `Expected session.text.delta, got: ${JSON.stringify(received)}`,
    );
    assert.ok(received.some((e) => e.type === 'session.idle'));

    // 5. Verify merged messages endpoint contains upstream + local agy user & assistant messages
    const msgs = await (await fetch(`${gwBase}/api/session/ses_test/message`)).json();
    assert.ok(msgs.data.some((m) => m.id === 'msg_oc'));
    assert.ok(msgs.data.some((m) => m.id === 'msg_u1' && m.text === 'hello agy'));
    assert.ok(msgs.data.some((m) => m.type === 'assistant' && m.content[0]?.text === 'hi from agy'));

    // 6. Switch back to OpenCode model -> prompt now goes to upstream OpenCode
    const swRes = await fetch(`${gwBase}/api/session/ses_test/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'opencode', id: 'gpt-5' } }),
    });
    assert.equal(swRes.status, 204);

    await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'msg_u2', text: 'hello opencode again' }),
    });
    assert.equal(upstreamPrompts.length, 1);
    assert.equal(upstreamPrompts[0].text, 'hello opencode again');

    sseAbort.abort();
    await pump;
  } finally {
    agyRunner.stopAll();
    sseHub.close();
    await new Promise((resolve) => router.close(resolve));
    for (const c of upstreamSseClients) c.end();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
