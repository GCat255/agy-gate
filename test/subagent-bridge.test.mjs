import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { RouterStore } from '../src/store.mjs';
import { AgyTurnTranslator } from '../src/event-translator.mjs';
import { AgyRunner } from '../src/agy-runner.mjs';
import { createRouterServer } from '../src/server.mjs';
import { invokeOpenChamberAgentTool } from '../src/mcp-bridge.mjs';
import {
  AgySubagentWatcher,
  AgyTranscriptTranslator,
  buildSubagentCompletionSynthetic,
  isAgyChildSessionID,
  resolveChildTranscriptPath,
  syncChildSessionFromTranscript,
  toChildSessionID,
} from '../src/subagent-bridge.mjs';

test('AgyTranscriptTranslator and AgySubagentWatcher convert transcript.jsonl into OpenCode child session events & store records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sub-watch-'));
  try {
    const store = new RouterStore(dir);
    const parentID = 'ses_parent_1';
    const childID = toChildSessionID('d82923a1-e02f-4023-8460-27b209de8bb2');
    assert.equal(isAgyChildSessionID(childID), true);

    store.setSessionDirectory(parentID, 'E:/proj');
    store.cacheSessionMetadata({ id: parentID, projectID: 'proj_123', location: { directory: 'E:/proj' } });
    store.createChildSession({
      sessionID: childID,
      parentID,
      projectID: 'proj_123',
      directory: 'E:/proj',
      title: 'Package Reader',
      agent: 'research',
      model: { providerID: 'agy-cli', id: 'gemini-3.8-flash-low' },
      agyConversationId: 'd82923a1-e02f-4023-8460-27b209de8bb2',
    });

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const lines = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T16:46:50Z',
        content: '<SYSTEM_MESSAGE>\n[Message] sender=parent content=Read package.json name.\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T16:46:50Z',
        model: 'gemini-3.8-flash-low',
        input_tokens: 9470,
        cache_read_tokens: 0,
        output_tokens: 114,
        tool_calls: [{ name: 'read_file', args: { Path: '"E:\\\\proj\\\\package.json"', StartLine: '1' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T16:46:53Z',
        content: '{"name":"agy-opencode-router"}',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T16:46:53Z',
        model: 'gemini-3.8-flash-low',
        input_tokens: 2367,
        cache_read_tokens: 7424,
        output_tokens: 124,
        tool_calls: [{ name: 'send_message', args: { Message: '"agy-opencode-router"', Recipient: '"parent-conv"' } }],
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T16:46:56Z',
        content: 'Message sent.',
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T16:46:57Z',
        model: 'gemini-3.8-flash-low',
        input_tokens: 2277,
        cache_read_tokens: 7751,
        output_tokens: 38,
        content: 'Package name is agy-opencode-router.',
      },
    ];
    fs.writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    const events = [];
    let completedInfo = null;
    const watcher = new AgySubagentWatcher({
      childSessionID: childID,
      parentSessionID: parentID,
      parentConversationId: 'parent-conv',
      agent: 'research',
      title: 'Package Reader',
      modelID: 'gemini-3.8-flash-low',
      directory: 'E:/proj',
      transcriptPath,
      store,
      emit: (ev) => events.push(ev),
      onComplete: (info) => {
        completedInfo = info;
      },
    });

    watcher.start();
    assert.ok(completedInfo);
    assert.equal(completedInfo.state, 'completed');
    assert.equal(completedInfo.output, 'Package name is agy-opencode-router.');
    assert.equal(completedInfo.tokens.total, 10066); // 2277 + 7751 + 38

    const eventTypes = events.map((e) => e.type);
    assert.ok(eventTypes.includes('session.step.started'));
    assert.ok(eventTypes.includes('session.tool.called'));
    assert.ok(eventTypes.includes('session.tool.success'));
    assert.ok(eventTypes.includes('session.text.ended'));
    assert.ok(eventTypes.includes('session.step.ended'));
    assert.ok(eventTypes.includes('session.execution.succeeded'));
    assert.ok(eventTypes.includes('session.idle'));

    const listed = store.listChildSessions({ directory: 'E:/proj' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].parentID, parentID);
    assert.equal(listed[0].outcome, 'succeeded');

    const childMsgs = store.getMessages(childID);
    assert.equal(childMsgs.length, 2);
    assert.equal(childMsgs[0].type, 'user');
    assert.equal(childMsgs[1].type, 'assistant');
    assert.equal(childMsgs[1].tokens.total, 10066);

    // Deleting parent cascades to child sessions
    store.deleteSession(parentID);
    assert.equal(store.listChildSessions({ directory: 'E:/proj' }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyTurnTranslator maps invoke_subagent to OpenCode subagent tool for foreground & background completions', () => {
  const fgEvents = [];
  let discovered = null;
  const trFg = new AgyTurnTranslator({
    sessionID: 'ses_p1',
    assistantMessageID: 'msg_p1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => fgEvents.push(ev),
    onSubagentDiscovered: (info) => {
      discovered = info;
    },
  });

  trFg.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{ type_name: 'research', role: 'Code Scout', initial_prompt: 'Inspect foo.js' }],
      },
    },
  });
  trFg.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'DONE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [
          {
            type_name: 'research',
            role: 'Code Scout',
            initial_prompt: 'Inspect foo.js',
            conversation_id: 'uuid-fg-1',
            log_uri: 'file:///tmp/transcript.jsonl',
          },
        ],
      },
    },
  });

  assert.equal(discovered.childSessionID, 'agy_sub_uuid-fg-1');
  assert.ok(fgEvents.some((e) => e.type === 'session.tool.called' && e.data.input.agent === 'research' && e.data.input.description === 'Code Scout'));
  assert.ok(fgEvents.some((e) => e.type === 'session.tool.progress' && e.data.metadata.sessionID === 'agy_sub_uuid-fg-1'));

  // Foreground resolution inside the same turn
  assert.equal(trFg.resolveSubagent('agy_sub_uuid-fg-1', { state: 'completed', output: 'All clear' }), true);
  trFg.handleLine({ event: 'result', result: { status: 'SUCCESS', response: 'Done' } });
  const fgMsg = trFg.toAssistantMessage();
  assert.equal(fgMsg.content[0].name, 'subagent');
  assert.equal(fgMsg.content[0].state.metadata.status, 'completed');
  assert.equal(fgMsg.content[0].state.metadata.sessionID, 'agy_sub_uuid-fg-1');

  // Background case: parent finishes before child completes
  const bgEvents = [];
  const trBg = new AgyTurnTranslator({
    sessionID: 'ses_p2',
    assistantMessageID: 'msg_p2',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => bgEvents.push(ev),
  });
  trBg.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'DONE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{ type_name: 'research', role: 'Bg Scout', initial_prompt: 'Scan', conversation_id: 'uuid-bg-1' }],
      },
    },
  });
  trBg.handleLine({ event: 'result', result: { status: 'SUCCESS', response: 'Started' } });
  assert.equal(trBg.resolveSubagent('agy_sub_uuid-bg-1', { state: 'completed', output: 'late' }), false);
  const bgMsg = trBg.toAssistantMessage();
  const bgTool = bgMsg.content.find((c) => c.type === 'tool' && c.name === 'subagent');
  assert.ok(bgTool);
  assert.equal(bgTool.state.metadata.status, 'running');
  assert.equal(bgTool.state.metadata.sessionID, 'agy_sub_uuid-bg-1');

  const syn = buildSubagentCompletionSynthetic({
    childSessionID: 'agy_sub_uuid-bg-1',
    agent: 'research',
    title: 'Bg Scout',
    state: 'completed',
    output: 'late',
    created: 1234,
  });
  assert.equal(syn.metadata.source, 'subagent');
  assert.equal(syn.metadata.childID, 'agy_sub_uuid-bg-1');
  assert.match(syn.text, /^<subagent sessionID="agy_sub_uuid-bg-1" state="completed" description="Bg Scout">/);
});

test('mcp-bridge blocks cross-engine openchamber subagent delegation while preserving non-subagent actions', async () => {
  const blocked = await invokeOpenChamberAgentTool({
    name: 'openchamber',
    args: { action: 'session.create', ownWork: true, prompt: 'do work' },
    env: {
      OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:9999/agent-tool',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'tok',
    },
    fetchImpl: async () => {
      throw new Error('fetch should not be called for blocked cross-engine subagents');
    },
  });
  const parsedBlocked = JSON.parse(blocked.text);
  assert.equal(parsedBlocked.ok, false);
  assert.match(parsedBlocked.error.message, /invoke_subagent/);

  let forwarded = false;
  const allowed = await invokeOpenChamberAgentTool({
    name: 'openchamber',
    args: { action: 'projects.list' },
    env: {
      OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:9999/agent-tool',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'tok',
    },
    fetchImpl: async () => {
      forwarded = true;
      return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'projects.list', data: [] }), { status: 200 });
    },
  });
  assert.equal(forwarded, true);
  assert.equal(JSON.parse(allowed.text).ok, true);
});

test('server queues /synthetic resume calls when agy-cli session is busy instead of dropping with 409', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-syn-queue-'));
  const mockAgyCmd = path.join(dir, process.platform === 'win32' ? 'mock-agy.cmd' : 'mock-agy.sh');
  const mockAgyJs = path.join(dir, 'mock-agy.mjs');
  fs.writeFileSync(
    mockAgyJs,
    [
      "import readline from 'node:readline';",
      "console.log(JSON.stringify({ event: 'init', conversation_id: 'conv_q', init: { model: 'gemini-4-hydrogen-high' } }));",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "let turn = 0;",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      "  if (msg.event !== 'user') return;",
      "  turn += 1;",
      "  const delay = turn === 1 ? 150 : 20;",
      "  setTimeout(() => {",
      "    console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: turn, state: 'DONE', step_type: 'agent_response', text_delta: `reply_${turn}`, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }));",
      "    console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv_q', status: 'SUCCESS', response: `reply_${turn}` } }));",
      "  }, delay);",
      "});",
    ].join('\n'),
    'utf8',
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(mockAgyCmd, `@echo off\r\n"${process.execPath}" "${mockAgyJs}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(mockAgyCmd, `#!/usr/bin/env bash\n"${process.execPath}" "${mockAgyJs}" "$@"\n`, { mode: 0o755 });
  }

  const store = new RouterStore(dir);
  store.setSessionModel('ses_busy', { providerID: 'agy-cli', id: 'gemini-4-hydrogen', variant: 'high' });
  store.setSessionDirectory('ses_busy', dir);

  const events = [];
  const sseHub = { broadcast: (ev) => events.push(ev) };
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = upstream.address().port;

  const runner = new AgyRunner({
    store,
    sseHub,
    env: {
      ...process.env,
      AGY_ROUTER_AGY_BIN: mockAgyCmd,
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
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/api/session/ses_busy/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'first turn' }),
    });
    assert.equal(r1.status, 200);

    // Immediately deliver /synthetic while turn 1 is still busy
    const r2 = await fetch(`http://127.0.0.1:${port}/api/session/ses_busy/synthetic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'follow-up callback', resume: true }),
    });
    assert.equal(r2.status, 200);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (store.getMessages('ses_busy').filter((m) => m.type === 'assistant').length >= 2) break;
      await new Promise((r) => setTimeout(r, 30));
    }

    const assistants = store.getMessages('ses_busy').filter((m) => m.type === 'assistant');
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].content[0].text, 'reply_1');
    assert.equal(assistants[1].content[0].text, 'reply_2');
  } finally {
    runner.stopAll();
    server.close();
    upstream.close();
    await new Promise((r) => setTimeout(r, 150));
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Ignore transient Windows cmd.exe handle release delay
    }
  }
});

test('subagent watcher and syncChildSession support follow-up send_message turns & send_message-only replies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sub-followup-'));
  try {
    const store = new RouterStore(dir);
    const parentID = 'ses_parent_followup';
    const parentConv = '649aad04-2a55-48d3-8186-4f33a443ae22';
    const childConv = '66ecafe7-7b2b-43b9-bd5b-141fc47fabcd';
    const childID = toChildSessionID(childConv);

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const turn1Lines = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T17:11:54Z',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T17:11:54Z sender=${parentConv} content=List workspace files.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T17:11:55Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 9360,
        cache_read_tokens: 0,
        output_tokens: 222,
        tool_calls: [{ name: 'send_message', args: { Message: '"Found 2 files."', Recipient: `"${parentConv}"` } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T17:11:58Z',
        content: `Message sent to "${parentConv}".`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T17:11:59Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 2383,
        cache_read_tokens: 7787,
        output_tokens: 63,
        content: 'Turn 1 complete.',
      },
    ];
    fs.writeFileSync(transcriptPath, `${turn1Lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    store.setSessionDirectory(parentID, 'E:/proj');
    store.setAgyConversationId(parentID, parentConv);
    store.createChildSession({
      sessionID: childID,
      parentID,
      projectID: 'proj_123',
      directory: 'E:/proj',
      title: 'Subagent Health Tester',
      agent: 'research',
      model: { providerID: 'agy-cli', id: 'gemini-4-hydrogen-high' },
      agyConversationId: childConv,
      parentConversationId: parentConv,
      transcriptPath,
    });

    const events = [];
    let onCompleteCount = 0;
    const watcher = new AgySubagentWatcher({
      childSessionID: childID,
      parentSessionID: parentID,
      parentConversationId: parentConv,
      agent: 'research',
      title: 'Subagent Health Tester',
      modelID: 'gemini-4-hydrogen-high',
      directory: 'E:/proj',
      transcriptPath,
      store,
      emit: (ev) => events.push(ev),
      onComplete: () => {
        onCompleteCount += 1;
      },
      pollMs: 30,
      replySettleMs: 60,
    });

    watcher.start();
    assert.equal(onCompleteCount, 1);
    assert.equal(watcher.settled, true);
    assert.equal(watcher.closed, false);
    assert.equal(store.getMessages(childID).map((m) => m.type).join(','), 'user,assistant');

    // Internal system reminder must NOT create a fake user turn, while follow-up send_message MUST start Turn 2
    const turn2Lines = [
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T17:12:00Z',
        content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 5,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T17:12:14Z',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T17:12:14Z sender=${parentConv} priority=MESSAGE_PRIORITY_HIGH content=Confirm file count via send_message.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 6,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T17:12:14Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 2281,
        cache_read_tokens: 8121,
        output_tokens: 199,
        tool_calls: [{ name: 'send_message', args: { Message: '"MSG_CHAIN_OK (2 files)"', Recipient: `"${parentConv}"` } }],
      },
      {
        step_index: 7,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T17:12:18Z',
        content: `Message sent to "${parentConv}".`,
      },
    ];
    fs.appendFileSync(transcriptPath, `${turn2Lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    // Waking watcher picks up Turn 2 live, then close('completed') settles send_message-only reply cleanly
    watcher.resume();
    watcher.close('completed');

    assert.equal(onCompleteCount, 1); // Initial parent tool/synthetic callback only fires once
    const msgs = store.getMessages(childID);
    assert.deepEqual(
      msgs.map((m) => m.type),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.equal(msgs[2].text, 'Confirm file count via send_message.');
    assert.equal(msgs[3].content.some((p) => p.type === 'tool' && p.name === 'send_message'), true);
    assert.equal(msgs[3].content.find((p) => p.type === 'text')?.text, 'MSG_CHAIN_OK (2 files)');
    assert.ok(msgs[0].time.created < msgs[1].time.created);
    assert.ok(msgs[1].time.created < msgs[2].time.created);
    assert.ok(msgs[2].time.created < msgs[3].time.created);

    // Total tokens accumulated across both Turn 1 & Turn 2
    const info = store.getChildSessionInfo(childID);
    assert.equal(info.tokens.input, 9360 + 2383 + 2281);
    assert.equal(info.tokens.output, 222 + 63 + 199);

    // Offline catch-up via AgyRunner.syncChildSession even if a Turn 3 lands after watcher closed
    // Note: agy `sender=system` server-restart notices must be skipped cleanly without extra user bubbles
    const turn3Lines = [
      {
        step_index: 8,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T17:13:00Z',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T17:13:00Z sender=${parentConv} content=Third check.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 9,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T17:13:00Z',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T17:13:00Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] Server restarted.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 10,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T17:13:01Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 100,
        output_tokens: 20,
        content: 'Third reply.',
      },
    ];
    fs.appendFileSync(transcriptPath, `${turn3Lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    const runner = new AgyRunner({ store, sseHub: { broadcast() {} }, env: process.env });
    assert.equal(runner.syncChildSession(childID), true);
    const afterSync = store.getMessages(childID);
    assert.deepEqual(
      afterSync.map((m) => m.type),
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
    );
    assert.equal(afterSync[5].content[0].text, 'Third reply.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('system_message wakeup flush does not split trailing child prose and sync repairs unclosed/legacy records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sub-repair-'));
  try {
    const store = new RouterStore(dir);
    const parentID = 'ses_p_wakeup';
    const parentConv = 'parent-conv-w';
    const childConv = 'child-uuid-repair-1';
    const childID = toChildSessionID(childConv);

    const legacyTranscriptDir = path.join(dir, '.gemini', 'antigravity-cli', 'brain', childConv, '.system_generated', 'logs');
    fs.mkdirSync(legacyTranscriptDir, { recursive: true });
    const legacyTranscriptPath = path.join(legacyTranscriptDir, 'transcript.jsonl');

    const step0to2 = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-21T17:29:01Z',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${parentConv} content=Check file.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T17:29:07Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 100,
        output_tokens: 20,
        thinking: 'Checking the requested file carefully.',
        tool_calls: [{ name: 'send_message', args: { Message: '"RESULT_OK"', Recipient: `"${parentConv}"` } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T17:29:11Z',
        content: `Message sent to "${parentConv}".`,
      },
    ];
    fs.writeFileSync(legacyTranscriptPath, `${step0to2.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    store.setSessionDirectory(parentID, 'E:/proj');
    store.setAgyConversationId(parentID, parentConv);
    store.createChildSession({
      sessionID: childID,
      parentID,
      directory: 'E:/proj',
      title: 'Fresh Subagent',
      agent: 'research',
      model: { providerID: 'agy-cli', id: 'gemini-4-hydrogen-high' },
      agyConversationId: childConv,
      parentConversationId: parentConv,
      transcriptPath: legacyTranscriptPath,
    });

    const runner = new AgyRunner({ store, sseHub: { broadcast() {} }, env: process.env });
    const watcher = new AgySubagentWatcher({
      childSessionID: childID,
      parentSessionID: parentID,
      parentConversationId: parentConv,
      agent: 'research',
      title: 'Fresh Subagent',
      modelID: 'gemini-4-hydrogen-high',
      directory: 'E:/proj',
      transcriptPath: legacyTranscriptPath,
      store,
      emit: () => {},
      replySettleMs: 5000,
    });
    runner.childWatchers.set(childID, { watcher, parentSessionID: parentID });
    watcher.flush({ settleReplyNow: false });

    // Simulate parent receiving system_message wakeup right before child writes step_index: 3 prose
    runner._flushSubagentWatchersForParent(parentID, { cancelRemaining: false, settleReplyNow: false });
    assert.equal(watcher.turnBusy, true);

    fs.appendFileSync(
      legacyTranscriptPath,
      `${JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T17:29:13Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 50,
        output_tokens: 15,
        content: 'Trailing summary complete.',
      })}\n`,
      'utf8',
    );
    watcher.flush({ settleReplyNow: false });

    const cleanMsgs = store.getMessages(childID);
    assert.deepEqual(
      cleanMsgs.map((m) => m.type),
      ['user', 'assistant'],
    );
    assert.ok(cleanMsgs[1].time.completed);
    assert.equal(cleanMsgs[1].content.find((p) => p.type === 'reasoning')?.text, 'Checking the requested file carefully.');
    assert.equal(cleanMsgs[1].content.find((p) => p.type === 'text')?.text, 'Trailing summary complete.');

    // Simulate a legacy/broken record missing transcriptPath & containing an unclosed assistant message
    store.updateChildSession(childID, {
      transcriptPath: null,
      lastSyncedLineCount: 4,
      busy: false,
    });
    store.replaceChildMessages(childID, [
      cleanMsgs[0],
      cleanMsgs[1],
      { id: 'msg_broken_unclosed', type: 'assistant', time: { created: Date.now() }, content: [{ type: 'text', text: 'dup' }] },
    ]);

    const legacyRec = store.getChildSessionRecord(childID);
    assert.equal(resolveChildTranscriptPath(legacyRec, dir), legacyTranscriptPath);
    assert.equal(syncChildSessionFromTranscript({ childRecord: legacyRec, store, homeDir: dir }), true);

    const repairedMsgs = store.getMessages(childID);
    assert.deepEqual(
      repairedMsgs.map((m) => m.type),
      ['user', 'assistant'],
    );
    assert.ok(repairedMsgs[1].time.completed);
    watcher.close('completed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
