import test from 'node:test';
import assert from 'node:assert/strict';
import { AgyTurnTranslator, isTransientAgyAuthErrorText } from '../src/agy/event-translator.mjs';

test('AgyTurnTranslator maps ACP thought, tool, text delta, usage_update, and prompt result into OpenCode events', () => {
  const events = [];

  const tr = new AgyTurnTranslator({
    sessionID: 'ses_1',
    assistantMessageID: 'msg_a1',
    modelID: 'gemini-4-hydrogen-high',
    directory: 'E:/proj',
    emit: (ev) => events.push(ev),
  });

  tr.begin();
  tr.handleAcpUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Plan first.' },
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    name: 'list_dir',
    args: { Path: '.' },
    rawInput: { Path: '.' },
    status: 'in_progress',
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    name: 'list_dir',
    args: { Path: '.' },
    rawInput: { Path: '.' },
    status: 'completed',
    rawOutput: 'a.txt',
    content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello ' },
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'world' },
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'usage_update',
    used: 21161,
    size: 1048576,
  });

  const msg = tr.completeFromPromptResult({
    stopReason: 'end_turn',
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      thoughtTokens: 1,
      cachedReadTokens: 5,
      cachedWriteTokens: 0,
      totalTokens: 17,
    },
  });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'session.execution.started',
    'session.step.started',
    'session.step.first-token',
    'session.reasoning.started',
    'session.reasoning.delta',
    'session.reasoning.ended',
    'session.tool.input.started',
    'session.tool.called',
    'session.tool.success',
    'session.step.ended',
    'session.step.started',
    'session.step.first-token',
    'session.text.started',
    'session.text.delta',
    'session.text.delta',
    'session.text.ended',
    'session.step.ended',
    'session.usage.updated',
    'session.execution.succeeded',
    'session.idle',
  ]);
  assert.equal(events[0].location.directory, 'E:/proj');

  const step1Ended = events.find((e) => e.type === 'session.step.ended' && e.data.finish === 'tool-calls');
  assert.ok(step1Ended);
  assert.equal(step1Ended.data.assistantMessageID, 'msg_a1');

  const step2Started = events.filter((e) => e.type === 'session.step.started')[1];
  assert.equal(step2Started.data.assistantMessageID, 'msg_a1_s02');

  const allMsgs = tr.toAssistantMessages();
  assert.equal(allMsgs.length, 2);
  assert.equal(allMsgs[0].id, 'msg_a1');
  assert.equal(allMsgs[0].finish, 'tool-calls');
  assert.deepEqual(
    allMsgs[0].content.map((c) => c.type),
    ['reasoning', 'tool'],
  );
  assert.equal(allMsgs[0].content[0].text, 'Plan first.');
  assert.equal(allMsgs[0].content[1].state.status, 'completed');

  assert.equal(msg.id, 'msg_a1_s02');
  assert.equal(msg.finish, 'stop');
  assert.ok(msg.time.created > allMsgs[0].time.created);
  assert.equal(msg.model.providerID, 'agy-cli');
  assert.equal(msg.model.id, 'gemini-4-hydrogen-high');
  assert.equal(msg.tokens.total, 21161);
  assert.equal(msg.tokens.input, 10);
  assert.equal(msg.tokens.output, 2);
  assert.equal(msg.tokens.reasoning, 1);
  assert.equal(msg.tokens.cache.read, 5);
  assert.deepEqual(
    msg.content.map((c) => c.type),
    ['text'],
  );
  assert.equal(msg.content[0].text, 'Hello world');
});

test('AgyTurnTranslator emits interrupted events on cancelled ACP stopReason or user cancel', () => {
  const events = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_2',
    assistantMessageID: 'msg_a2',
    modelID: 'gemini-3.8-flash-low',
    emit: (ev) => events.push(ev),
  });
  tr.begin();
  const msg = tr.completeFromPromptResult({
    stopReason: 'cancelled',
    usage: { inputTokens: 100, outputTokens: 5, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
  });
  assert.equal(msg.finish, 'unknown');
  assert.equal(msg.tokens.input, 100);
  assert.ok(events.some((e) => e.type === 'session.execution.interrupted'));
  assert.ok(events.some((e) => e.type === 'session.idle'));
});

test('AgyTurnTranslator unwraps call_mcp_tool OpenChamber calls and accumulates multi-turn sessionTokens', () => {
  const turn1Events = [];
  const tr1 = new AgyTurnTranslator({
    sessionID: 'ses_usage',
    assistantMessageID: 'msg_u1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => turn1Events.push(ev),
  });

  tr1.begin();
  tr1.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_oc_1',
    name: 'call_mcp_tool',
    rawInput: {
      ServerName: 'openchamber',
      ToolName: 'openchamber_render',
      Arguments: { action: 'render.page', awaitAnswer: true },
    },
    status: 'in_progress',
  });
  tr1.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_oc_1',
    name: 'call_mcp_tool',
    rawInput: {
      ServerName: 'openchamber',
      ToolName: 'openchamber_render',
      Arguments: { action: 'render.page', awaitAnswer: true },
    },
    status: 'completed',
    rawOutput: JSON.stringify({ schemaVersion: 1, ok: true, action: 'render.page', data: { answer: { choice: 'A' } } }),
  });
  tr1.handleAcpUpdate({ sessionUpdate: 'usage_update', used: 15918, size: 1048576 });

  const msg1 = tr1.completeFromPromptResult({
    stopReason: 'end_turn',
    usage: { inputTokens: 17885, outputTokens: 323, thoughtTokens: 271, cachedReadTokens: 13450, cachedWriteTokens: 0 },
  });

  assert.equal(msg1.content[0].name, 'openchamber_render');
  assert.deepEqual(msg1.content[0].state.metadata.openchamber, {
    schemaVersion: 1,
    action: 'render.page',
    ok: true,
    answer: { choice: 'A' },
  });
  assert.equal(msg1.tokens.total, 15918);
  assert.equal(msg1.tokens.input, 17885);

  const turn2Events = [];
  const tr2 = new AgyTurnTranslator({
    sessionID: 'ses_usage',
    assistantMessageID: 'msg_u2',
    modelID: 'gemini-4-hydrogen-high',
    priorSessionTokens: tr1.sessionTokens,
    emit: (ev) => turn2Events.push(ev),
  });

  tr2.begin();
  tr2.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
  tr2.handleAcpUpdate({ sessionUpdate: 'usage_update', used: 18000, size: 1048576 });

  const msg2 = tr2.completeFromPromptResult({
    stopReason: 'end_turn',
    usage: { inputTokens: 4395, outputTokens: 116, thoughtTokens: 0, cachedReadTokens: 26498, cachedWriteTokens: 0 },
  });

  assert.equal(msg2.tokens.total, 18000);
  assert.equal(msg2.tokens.input, 4395);
  assert.equal(msg2.tokens.output, 116);
  assert.equal(msg2.tokens.cache.read, 26498);

  const usageEvt2 = turn2Events.find((e) => e.type === 'session.usage.updated');
  assert.deepEqual(usageEvt2.data.tokens, {
    input: 22280,
    output: 439,
    reasoning: 271,
    cache: { read: 39948, write: 0 },
  });
});

test('AgyTurnTranslator splits multi-step tool turns into OpenCode assistant step messages and isolates pre-tool prose', () => {
  const events = [];
  const settled = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_r',
    assistantMessageID: 'msg_r1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => events.push(ev),
    onStepSettled: (m) => settled.push(m),
  });

  tr.begin();
  tr.handleAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Plan tool read first.' } });
  tr.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking a.txt...' } });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_r1',
    name: 'read_file',
    rawInput: { Path: 'a.txt' },
    status: 'in_progress',
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_r1',
    name: 'read_file',
    rawInput: { Path: 'a.txt' },
    status: 'completed',
    rawOutput: 'ok',
  });
  tr.handleAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Summarize file content.' } });
  tr.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });

  const inFlightMid = tr.toInFlightAssistantMessages();
  assert.equal(inFlightMid.length, 2);
  assert.equal(inFlightMid[0].id, 'msg_r1');
  assert.equal(inFlightMid[0].finish, 'tool-calls');
  assert.equal(inFlightMid[1].id, 'msg_r1_s02');
  assert.equal(inFlightMid[1].finish, undefined);
  assert.equal(inFlightMid[1].content[1].text, 'Done.');

  const msg = tr.completeFromPromptResult({ stopReason: 'end_turn' });
  const msgs = tr.toAssistantMessages();
  assert.equal(msgs.length, 2);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].id, 'msg_r1');
  assert.equal(msgs[0].finish, 'tool-calls');
  assert.deepEqual(
    msgs[0].content.map((c) => c.type),
    ['reasoning', 'text', 'tool'],
  );
  assert.equal(msgs[0].content[0].text, 'Plan tool read first.');
  assert.equal(msgs[0].content[1].text, 'Checking a.txt...');

  assert.equal(msg.id, 'msg_r1_s02');
  assert.equal(msg.finish, 'stop');
  assert.deepEqual(
    msg.content.map((c) => c.type),
    ['reasoning', 'text'],
  );
  assert.equal(msg.content[0].text, 'Summarize file content.');
  assert.equal(msg.content[1].text, 'Done.');
  assert.equal(events.filter((e) => e.type === 'session.reasoning.ended').length, 2);
});

test('AgyTurnTranslator keeps parallel tools in one step and avoids trailing empty step when turn ends after tools', () => {
  const events = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_par',
    assistantMessageID: 'msg_par',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => events.push(ev),
  });

  tr.begin();
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_p1',
    name: 'read_file',
    rawInput: { Path: 'a.txt' },
    status: 'in_progress',
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_p2',
    name: 'read_file',
    rawInput: { Path: 'b.txt' },
    status: 'in_progress',
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_p1',
    name: 'read_file',
    rawInput: { Path: 'a.txt' },
    status: 'completed',
    rawOutput: 'A',
  });
  assert.equal(events.filter((e) => e.type === 'session.step.started').length, 1);

  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_p2',
    name: 'read_file',
    rawInput: { Path: 'b.txt' },
    status: 'completed',
    rawOutput: 'B',
  });

  const finalMsg = tr.completeFromPromptResult({ stopReason: 'end_turn' });
  const msgs = tr.toAssistantMessages();
  assert.equal(msgs.length, 1);
  assert.equal(finalMsg.finish, 'stop');
  assert.deepEqual(
    finalMsg.content.map((c) => c.type),
    ['tool', 'tool'],
  );
});

test('AgyTurnTranslator routes cross-step subagent completion back to the originating step message', () => {
  const events = [];
  const settled = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_sub_cross',
    assistantMessageID: 'msg_sc',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => events.push(ev),
    onStepSettled: (m) => settled.push(m),
  });

  tr.begin();
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_sub_1',
    name: 'invoke_subagent',
    rawInput: { TypeName: 'research', Role: 'Scout', Prompt: 'Scan' },
    status: 'in_progress',
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_sub_1',
    name: 'invoke_subagent',
    rawInput: { TypeName: 'research', Role: 'Scout', Prompt: 'Scan' },
    status: 'completed',
  });
  assert.equal(tr.attachDiscoveredSubagent('agy_sub_cross_1'), true);

  // Parent moves on to step 2 while subagent is still running
  tr.handleAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Working on next step...' },
  });

  const mid = tr.toInFlightAssistantMessages();
  assert.equal(mid.length, 2);
  assert.equal(mid[0].id, 'msg_sc');
  assert.equal(mid[0].content[0].state.status, 'running');
  assert.equal(mid[1].id, 'msg_sc_s02');

  // Subagent resolves while parent is in step 2
  assert.equal(tr.resolveSubagent('agy_sub_cross_1', { state: 'completed', output: 'Done scan' }), true);
  const subSuccess = events.find((e) => e.type === 'session.tool.success' && e.data.id === 'call_sub_1');
  assert.equal(subSuccess.data.assistantMessageID, 'msg_sc');
  assert.equal(settled.at(-1).id, 'msg_sc');
  assert.equal(settled.at(-1).content[0].state.status, 'completed');

  tr.completeFromPromptResult({ stopReason: 'end_turn' });
  const msgs = tr.toAssistantMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content[0].name, 'subagent');
  assert.equal(msgs[1].content[0].text, 'Working on next step...');
});

test('AgyTurnTranslator preserves openchamber_render answer metadata even when ACP duplicates rawOutput and MCP content', () => {
  const events = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_oc_render',
    assistantMessageID: 'msg_oc_r1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => events.push(ev),
  });

  const renderEnvelope = {
    schemaVersion: 1,
    ok: true,
    action: 'render.page',
    data: {
      title: 'Timing choice',
      answer: {
        answered: true,
        summary: 'Sync mask fade',
        data: { button: 'Send', values: { timing: 'Sync mask fade' } },
      },
    },
  };
  const jsonStr = JSON.stringify(renderEnvelope);

  tr.begin();
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_oc_1',
    name: 'call_mcp_tool',
    rawInput: {
      ServerName: 'openchamber',
      ToolName: 'openchamber_render',
      Arguments: JSON.stringify({ action: 'render.page', ui: 'root = Stack([])', awaitAnswer: true, title: 'Timing choice' }),
    },
    status: 'in_progress',
  });
  tr.handleAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_oc_1',
    status: 'completed',
    rawOutput: { content: [{ type: 'text', text: jsonStr }] },
    content: [{ type: 'content', content: { type: 'text', text: jsonStr } }],
  });

  const msg = tr.completeFromPromptResult({ stopReason: 'end_turn' });
  const successEvt = events.find((e) => e.type === 'session.tool.success' && e.data.id === 'call_oc_1');
  assert.ok(successEvt);
  assert.deepEqual(successEvt.data.metadata?.openchamber, {
    schemaVersion: 1,
    action: 'render.page',
    description: 'Timing choice',
    ok: true,
    answer: renderEnvelope.data.answer,
  });
  assert.deepEqual(msg.content[0].state.metadata?.openchamber, successEvt.data.metadata.openchamber);
});

test('AgyTurnTranslator flushes open tools on interrupt/fail and omits idle on steer interrupt', () => {
  const steerEvents = [];
  const trSteer = new AgyTurnTranslator({
    sessionID: 'ses_steer_tr',
    assistantMessageID: 'msg_st_1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => steerEvents.push(ev),
  });
  trSteer.begin();
  trSteer.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_open_1',
    name: 'read_file',
    rawInput: { Path: 'a.txt' },
    status: 'in_progress',
  });
  const steerMsg = trSteer.interrupt('superseded', { emitIdle: false, toolMessage: 'Interrupted by follow-up message' });
  assert.equal(steerMsg.finish, 'unknown');
  assert.equal(steerMsg.content.length, 1);
  assert.equal(steerMsg.content[0].state.status, 'error');
  assert.equal(steerMsg.content[0].state.error.message, 'Interrupted by follow-up message');
  assert.ok(steerEvents.some((e) => e.type === 'session.tool.failed' && e.data.id === 'call_open_1'));
  assert.ok(steerEvents.some((e) => e.type === 'session.step.ended' && e.data.finish === 'unknown'));
  assert.equal(steerEvents.some((e) => e.type === 'session.execution.interrupted'), false);
  assert.equal(steerEvents.some((e) => e.type === 'session.idle'), false);

  const failEvents = [];
  const trFail = new AgyTurnTranslator({
    sessionID: 'ses_fail_tr',
    assistantMessageID: 'msg_fl_1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => failEvents.push(ev),
  });
  trFail.begin();
  trFail.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_open_2',
    name: 'run_command',
    rawInput: { CommandLine: 'sleep 10' },
    status: 'in_progress',
  });
  const failMsg = trFail.fail('ACP crashed');
  assert.equal(failMsg.finish, 'error');
  assert.equal(failMsg.content[0].state.status, 'error');
  assert.equal(failMsg.content[0].state.error.message, 'ACP crashed');
  assert.ok(failEvents.some((e) => e.type === 'session.tool.failed' && e.data.id === 'call_open_2'));
  assert.ok(failEvents.some((e) => e.type === 'session.execution.failed'));
});

test('isTransientAgyAuthErrorText matches 401/UNAUTHENTICATED variants and ignores normal text', () => {
  assert.equal(
    isTransientAgyAuthErrorText(
      '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
    ),
    true,
  );
  assert.equal(
    isTransientAgyAuthErrorText('agent executor error: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.'),
    true,
  );
  assert.equal(isTransientAgyAuthErrorText('⚠ Caution: workspace has uncommitted files'), false);
  assert.equal(isTransientAgyAuthErrorText('HTTP 404 Not Found'), false);
  assert.equal(isTransientAgyAuthErrorText(''), false);
});

test('AgyTurnTranslator buffers ⚠ prefix, suppresses 401 on retry, flushes benign warnings, and exposes exhausted 401', () => {
  // 1. Benign ⚠ warning chunked across deltas flushes intact
  const warnEvents = [];
  const trWarn = new AgyTurnTranslator({
    sessionID: 'ses_warn',
    assistantMessageID: 'msg_warn',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => warnEvents.push(ev),
  });
  trWarn.begin();
  trWarn.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ ' } });
  trWarn.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Watch out for symlinks.' } });
  const warnMsg = trWarn.completeFromPromptResult({ stopReason: 'end_turn' });
  assert.equal(trWarn.authErrorDetected, false);
  assert.equal(warnMsg.content[0].text, '⚠ Watch out for symlinks.');
  assert.ok(warnEvents.some((e) => e.type === 'session.text.delta' && String(e.data?.delta || '').includes('Watch out')));

  // 2. Step-1 401 is suppressed during retry, leaving zero leaked delta events
  const retryEvents = [];
  const trRetry = new AgyTurnTranslator({
    sessionID: 'ses_auth_retry',
    assistantMessageID: 'msg_auth_retry',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => retryEvents.push(ev),
  });
  trRetry.begin();
  trRetry.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ UNAUTHENTICATED (code ' } });
  trRetry.handleAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '401): Request had invalid authentication credentials.' },
  });
  assert.equal(trRetry.authErrorDetected, true);
  assert.equal(trRetry.hasNonErrorProgress(), false);
  assert.equal(retryEvents.some((e) => e.type === 'session.text.delta'), false);
  trRetry.prepareForAuthRetry();
  assert.equal(trRetry.authErrorDetected, false);
  trRetry.handleAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered answer.' } });
  const recoveredMsg = trRetry.completeFromPromptResult({ stopReason: 'end_turn' });
  assert.equal(recoveredMsg.content[0].text, 'Recovered answer.');

  // 3. After tool progress, hasNonErrorProgress is true and exhausted retry still surfaces error text
  const exEvents = [];
  const trEx = new AgyTurnTranslator({
    sessionID: 'ses_auth_ex',
    assistantMessageID: 'msg_auth_ex',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => exEvents.push(ev),
  });
  trEx.begin();
  trEx.handleAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_ex_1',
    name: 'read_file',
    rawInput: { Path: 'README.md' },
    status: 'completed',
    rawOutput: 'ok',
  });
  assert.equal(trEx.hasNonErrorProgress(), true);
  trEx.handleAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.' },
  });
  const finalMsg = trEx.completeFromPromptResult({ stopReason: 'end_turn' });
  assert.equal(trEx.authErrorDetected, true);
  assert.ok(finalMsg.content.some((p) => p.type === 'text' && p.text.includes('UNAUTHENTICATED (code 401)')));
});
