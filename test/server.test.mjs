import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStore } from '../src/gateway/store.mjs';
import { SseHub } from '../src/gateway/sse-hub.mjs';
import { AgyRunner } from '../src/agy/runner.mjs';
import { createRouterServer } from '../src/gateway/server.mjs';
import { AGY_PROVIDER_ID, buildAgyProviderInfo, toOpenCodeModelInfo } from '../src/agy/models.mjs';

test('router server injects variant models, reuses warm ACP worker across turns, sends native image blocks, and splits traffic', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-router-e2e-'));
  const mockAgyCmd = path.join(tempDir, process.platform === 'win32' ? 'mock-agy.cmd' : 'mock-agy.sh');
  const mockAgyJs = path.join(tempDir, 'mock-agy.mjs');
  const bootCountFile = path.join(tempDir, 'boot-count.txt');
  const promptsLogFile = path.join(tempDir, 'prompts-log.json');
  const localImgPath = path.join(tempDir, 'local.png');
  const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(localImgPath, Buffer.from(tinyPngB64, 'base64'));
  const transcriptDir = path.join(tempDir, '.gemini', 'antigravity-cli', 'brain', 'conv_mock_acp', '.system_generated', 'logs');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');

  // Persistent warm ACP mock implementing `models` and `acp` JSON-RPC 2.0
  fs.writeFileSync(
    mockAgyJs,
    [
      "import fs from 'node:fs';",
      "import readline from 'node:readline';",
      "if (process.argv.includes('models')) {",
      "  console.log('gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)');",
      "  console.log('gemini-4-hydrogen-high\\tGemini 4 Hydrogen (High)');",
      "  console.log('gpt-oss-120b-medium\\tGPT-OSS 120B (Medium)');",
      "  process.exit(0);",
      "}",
      `const countFile = ${JSON.stringify(bootCountFile)};`,
      `const logFile = ${JSON.stringify(promptsLogFile)};`,
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      "const prev = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;",
      "fs.writeFileSync(countFile, String(prev + 1), 'utf8');",
      "const conv = 'conv_mock_acp';",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "let turn = 0;",
      "let pendingPromptReqId = null;",
      "let pendingTimer = null;",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const req = JSON.parse(line);",
      "  if (req.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }));",
      "    return;",
      "  }",
      "  if (req.method === 'session/new' || req.method === 'session/resume') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: conv } }));",
      "    return;",
      "  }",
      "  if (req.method === 'session/set_model' || req.method === 'session/set_config_option') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }));",
      "    return;",
      "  }",
      "  if (req.method === 'session/cancel') {",
      "    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }",
      "    if (pendingPromptReqId !== null) {",
      "      const pid = pendingPromptReqId;",
      "      pendingPromptReqId = null;",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', id: pid, result: { stopReason: 'cancelled', usage: { inputTokens: 4, outputTokens: 1 } } }));",
      "    }",
      "    return;",
      "  }",
      "  if (req.method === 'session/prompt') {",
      "    const logs = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];",
      "    logs.push(req.params?.prompt || []);",
      "    fs.writeFileSync(logFile, JSON.stringify(logs), 'utf8');",
      "    turn += 1;",
      "    const firstText = (req.params?.prompt || []).find((b) => b.type === 'text')?.text || '';",
      "    if (firstText.includes('summarize session')) {",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi from agy' } } } }));",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } } }));",
      "      return;",
      "    }",
      "    if (firstText === '/compact') {",
      "      fs.appendFileSync(transcriptPath, JSON.stringify({ step_index: 99, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', content: '# Resuming from a compaction\\n\\n<summary>Compacted session summary.</summary>' }) + '\\n', 'utf8');",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'usage_update', used: 1200, size: 1000000 } } }));",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 50, cachedReadTokens: 100 } } }));",
      "      return;",
      "    }",
      "    if (firstText.includes('wait cancel')) {",
      "      pendingPromptReqId = req.id;",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } }));",
      "      pendingTimer = setTimeout(() => {",
      "        if (pendingPromptReqId === req.id) {",
      "          pendingPromptReqId = null;",
      "          console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }));",
      "        }",
      "      }, 3000);",
      "      return;",
      "    }",
      "    if (firstText.includes('slow first')) {",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'tool_call', toolCallId: 'call_slow_1', name: 'read_file', rawInput: { Path: 'a.txt' }, status: 'in_progress' } } }));",
      "      setTimeout(() => {",
      "        console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_slow_1', name: 'read_file', rawInput: { Path: 'a.txt' }, status: 'completed', rawOutput: 'ok' } } }));",
      "        console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slow done' } } } }));",
      "        console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }));",
      "      }, 220);",
      "      return;",
      "    }",
      "    if (firstText.includes('queued follow-up')) {",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'queued done' } } } }));",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }));",
      "      return;",
      "    }",
      "    const reply = turn === 1 ? 'hi from ' : turn === 2 ? 'warm turn 2' : turn === 3 ? 'synthetic reply' : 'image ok';",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } }));",
      "    if (turn === 1) {",
      "      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agy' } } } }));",
      "    }",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: conv, update: { sessionUpdate: 'usage_update', used: 20, size: 1000000 } } }));",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 3, cachedReadTokens: 5 } } }));",
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

    if (req.method === 'POST' && url.pathname === '/api/experimental/generate/text') {
      const parsed = JSON.parse(bodyText || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { text: `upstream:${parsed?.model?.id}:${parsed?.prompt}` } }));
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
    env: {
      ...process.env,
      AGY_ROUTER_AGY_BIN: mockAgyCmd,
      AGY_ROUTER_MAGPIE_BIN: path.join(tempDir, 'no-magpie.exe'),
      AGY_ROUTER_HOME_DIR: tempDir,
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
      models: [
        toOpenCodeModelInfo({ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', variants: ['low', 'high'] }),
        toOpenCodeModelInfo({ id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }),
      ],
      variantTargets: new Map([
        ['gemini-4-hydrogen', new Map([['low', 'gemini-4-hydrogen-low'], ['high', 'gemini-4-hydrogen-high'], ['__default__', 'gemini-4-hydrogen-high']])],
        ['gpt-oss-120b-medium', new Map([['__default__', 'gpt-oss-120b-medium']])],
      ]),
    }),
  });

  await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
  const gwPort = router.address().port;
  const gwBase = `http://127.0.0.1:${gwPort}`;
  sseHub.startUpstream();

  try {
    // 1. Check provider & variant model injection (including image capability)
    const providers = await (await fetch(`${gwBase}/api/provider`)).json();
    assert.deepEqual(providers.data.map((p) => p.id), ['opencode', AGY_PROVIDER_ID]);

    const models = await (await fetch(`${gwBase}/api/model?types=chat`)).json();
    assert.deepEqual(models.data.map((m) => `${m.providerID}/${m.id}`), [
      'opencode/gpt-5',
      'agy-cli/gemini-4-hydrogen',
      'agy-cli/gpt-oss-120b-medium',
    ]);
    assert.deepEqual(models.data[1].variants.map((v) => v.id), ['low', 'high']);
    assert.deepEqual(models.data[1].capabilities.input, ['text', 'image']);
    assert.deepEqual(models.data[2].capabilities.input, ['text']);

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

    // 3. Create session with agy-cli variant model
    const created = await (
      await fetch(`${gwBase}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
        body: JSON.stringify({ model: { providerID: AGY_PROVIDER_ID, id: 'gemini-4-hydrogen', variant: 'high' } }),
      })
    ).json();
    assert.equal(created.data.model.providerID, AGY_PROVIDER_ID);
    assert.equal(created.data.model.variant, 'high');

    // 4. Turn 1 -> spawns warm ACP worker
    const promptRes = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_u1', text: 'hello agy' }),
    });
    assert.equal(promptRes.status, 200);
    assert.equal(upstreamPrompts.length, 0);

    let deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.idle').length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(
      received.some((e) => e.type === 'session.text.delta' && e.data.delta === 'hi from '),
      `Expected session.text.delta, got: ${JSON.stringify(received)}`,
    );

    // 5. Turn 2 -> reuses the SAME warm ACP worker process (boot count remains 1!)
    const prompt2Res = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_u1b', text: 'second turn' }),
    });
    assert.equal(prompt2Res.status, 200);
    deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.idle').length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(fs.readFileSync(bootCountFile, 'utf8').trim(), '1', 'Warm ACP worker should serve turn 2 without respawning');

    // 5b. Guidance is injected once on turn 1 and not repeated on turn 2; synthetic non-resume queues + resume triggers turn
    const synNoResume = await fetch(`${gwBase}/api/session/ses_test/synthetic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_syn_ctx', text: 'use: deploy', resume: false }),
    });
    assert.equal(synNoResume.status, 200);
    const synResume = await fetch(`${gwBase}/api/session/ses_test/synthetic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({
        id: 'msg_syn_card',
        text: 'Picked Option A',
        metadata: { openchamberUiBlockAnswer: { messageId: 'msg_a', block: 'blk_1', answer: { option: 'A' } } },
        resume: true,
      }),
    });
    assert.equal(synResume.status, 200);
    deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.idle').length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }

    // 5c. Turn 4 -> sends inline data:image/png;base64 and local file:// image natively to ACP prompt
    const imgPromptRes = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({
        id: 'msg_u_img',
        text: 'Describe these screenshots',
        files: [
          { uri: `data:image/png;base64,${tinyPngB64}`, name: 'shot.png' },
          { uri: `file://${localImgPath.replace(/\\/g, '/')}`, name: 'local.png' },
        ],
      }),
    });
    assert.equal(imgPromptRes.status, 200);
    deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.idle').length < 4 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }

    const loggedPrompts = JSON.parse(fs.readFileSync(promptsLogFile, 'utf8'));
    assert.ok(loggedPrompts[0][0].text.includes('<openchamber_runtime_guidance>'));
    assert.ok(!loggedPrompts[1][0].text.includes('<openchamber_runtime_guidance>'));
    assert.ok(loggedPrompts[2][0].text.includes('use: deploy') && loggedPrompts[2][0].text.includes('Picked Option A'));
    assert.equal(loggedPrompts[3][0].type, 'text');
    assert.equal(loggedPrompts[3][0].text, 'Describe these screenshots');
    assert.deepEqual(loggedPrompts[3][1], { type: 'image', mimeType: 'image/png', data: tinyPngB64 });
    assert.deepEqual(loggedPrompts[3][2], { type: 'image', mimeType: 'image/png', data: tinyPngB64 });

    // 5d. Turn 5 -> POST /interrupt sends ACP session/cancel and settles with interrupted state
    const cancelPromptRes = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_u_cancel', text: 'wait cancel' }),
    });
    assert.equal(cancelPromptRes.status, 200);
    deadline = Date.now() + 3000;
    while (!received.some((e) => e.type === 'session.text.delta' && e.data.delta === 'partial') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const intrRes = await fetch(`${gwBase}/api/session/ses_test/interrupt`, { method: 'POST' });
    assert.equal(intrRes.status, 200);
    deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.idle').length < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(received.some((e) => e.type === 'session.execution.interrupted'));

    // 5e. POST /compact -> returns 400 for empty agy session, and compacts active session via ACP /compact + CHECKPOINT
    store.setSessionModel('ses_empty_agy', { providerID: AGY_PROVIDER_ID, id: 'gemini-4-hydrogen', variant: 'high' });
    const emptyCompactRes = await fetch(`${gwBase}/api/session/ses_empty_agy/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(emptyCompactRes.status, 400);

    const compactRes = await fetch(`${gwBase}/api/session/ses_test/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_cmp_1' }),
    });
    assert.equal(compactRes.status, 200);
    deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.compaction.ended').length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const cmpStarted = received.find((e) => e.type === 'session.compaction.started');
    const cmpEnded = received.find((e) => e.type === 'session.compaction.ended');
    assert.ok(cmpStarted && cmpEnded);
    assert.equal(cmpStarted.data.inputID, 'msg_cmp_1');
    assert.equal(cmpEnded.id, 'evt_cmp_1');
    assert.equal(cmpEnded.data.text, 'Compacted session summary.');
    deadline = Date.now() + 2000;
    while (!received.some((e) => e.type === 'session.idle' && e.created >= cmpEnded.created) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }

    // 5f. Mid-turn GET /message exposes live in-flight assistant snapshot & busy POST /prompt queues follow-up cleanly
    const idleCountBeforeQueue = received.filter((e) => e.type === 'session.idle').length;
    const slowRes = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_u_slow', text: 'slow first' }),
    });
    assert.equal(slowRes.status, 200);

    deadline = Date.now() + 2000;
    while (!received.some((e) => e.type === 'session.tool.called' && e.data?.id === 'call_slow_1') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    const midMsgs = await (await fetch(`${gwBase}/api/session/ses_test/message`)).json();
    const inFlightAssist = midMsgs.data.find((m) => m.type === 'assistant' && !m.finish);
    assert.ok(inFlightAssist, 'GET /message must include live in-flight assistant message while turn is running');
    assert.equal(inFlightAssist.content.some((p) => p.type === 'tool' && p.state?.status === 'running'), true);

    const queuedRes = await fetch(`${gwBase}/api/session/ses_test/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
      body: JSON.stringify({ id: 'msg_u_queued', text: 'queued follow-up' }),
    });
    assert.equal(queuedRes.status, 200);

    deadline = Date.now() + 5000;
    while (received.filter((e) => e.type === 'session.idle').length < idleCountBeforeQueue + 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const afterQueueMsgs = await (await fetch(`${gwBase}/api/session/ses_test/message`)).json();
    assert.ok(afterQueueMsgs.data.some((m) => m.type === 'assistant' && m.content?.some((p) => p.type === 'text' && p.text === 'slow done')));
    assert.ok(afterQueueMsgs.data.some((m) => m.type === 'assistant' && m.content?.some((p) => p.type === 'text' && p.text === 'queued done')));

    // 6. Verify merged messages endpoint contains upstream + local agy user, synthetic & assistant messages
    const msgs = await (await fetch(`${gwBase}/api/session/ses_test/message`)).json();
    assert.ok(msgs.data.some((m) => m.id === 'msg_oc'));
    assert.ok(msgs.data.some((m) => m.id === 'msg_u1' && m.text === 'hello agy'));
    assert.ok(msgs.data.some((m) => m.id === 'msg_syn_card' && m.type === 'synthetic' && m.metadata?.openchamberUiBlockAnswer));
    assert.ok(msgs.data.some((m) => m.type === 'assistant' && m.content[0]?.text === 'hi from agy'));
    assert.ok(msgs.data.some((m) => m.type === 'assistant' && m.content[0]?.text === 'warm turn 2'));
    assert.ok(msgs.data.some((m) => m.type === 'assistant' && m.content[0]?.text === 'synthetic reply'));
    assert.ok(msgs.data.some((m) => m.type === 'assistant' && m.content[0]?.text === 'image ok'));
    const imgUserMsg = msgs.data.find((m) => m.id === 'msg_u_img');
    assert.ok(imgUserMsg?.files?.length === 2);
    assert.equal(imgUserMsg.files[0].mime, 'image/png');
    assert.equal(imgUserMsg.files[0].source?.type, 'uri');
    assert.equal(imgUserMsg.files[0].source?.uri, `data:image/png;base64,${tinyPngB64}`);

    // Legacy stored user message missing `files[].source` & `mime` must be normalized on read
    store.upsertMessage('ses_test', {
      id: 'msg_legacy_file',
      type: 'user',
      time: { created: Date.now() },
      text: 'legacy',
      files: [{ uri: 'data:text/plain;base64,SGVsbG8=', name: 'image-1.png' }],
    });
    const msgsAfterLegacy = await (await fetch(`${gwBase}/api/session/ses_test/message`)).json();
    const legacyMsg = msgsAfterLegacy.data.find((m) => m.id === 'msg_legacy_file');
    assert.equal(legacyMsg.files[0].mime, 'text/plain');
    assert.deepEqual(legacyMsg.files[0].source, { type: 'uri', uri: 'data:text/plain;base64,SGVsbG8=' });

    // 7. Switch back to OpenCode model -> prompt now goes to upstream OpenCode
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

    // 8. /api/experimental/generate/text routes agy-cli locally via ACP and forwards opencode upstream
    const genAgy = await (
      await fetch(`${gwBase}/api/experimental/generate/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': 'E:/proj' },
        body: JSON.stringify({
          prompt: 'summarize session',
          model: { providerID: AGY_PROVIDER_ID, id: 'gemini-4-hydrogen', variant: 'low' },
        }),
      })
    ).json();
    assert.equal(genAgy.data.text, 'hi from agy');

    const genUp = await (
      await fetch(`${gwBase}/api/experimental/generate/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'hello small model',
          model: { providerID: 'opencode', id: 'gpt-5' },
        }),
      })
    ).json();
    assert.equal(genUp.data.text, 'upstream:gpt-5:hello small model');

    sseAbort.abort();
    await pump;
  } finally {
    agyRunner.stopAll();
    sseHub.close();
    await new Promise((resolve) => router.close(resolve));
    for (const c of upstreamSseClients) c.end();
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
});
