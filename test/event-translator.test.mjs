import test from 'node:test';
import assert from 'node:assert/strict';
import { AgyTurnTranslator } from '../src/event-translator.mjs';

test('AgyTurnTranslator maps init, tool, text delta, and result into OpenCode events', () => {
  const events = [];
  let convId = null;

  const tr = new AgyTurnTranslator({
    sessionID: 'ses_1',
    assistantMessageID: 'msg_a1',
    modelID: 'gemini-4-hydrogen-high',
    directory: 'E:/proj',
    emit: (ev) => events.push(ev),
    onConversationId: (id) => {
      convId = id;
    },
  });

  tr.handleLine({ event: 'init', conversation_id: 'conv_abc' });
  tr.handleLine({
    event: 'step_update',
    step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'list_dir',
      tool_info: { name: 'list_dir', parameters: { Path: '.' } },
    },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'list_dir',
      tool_info: { name: 'list_dir', parameters: { Path: '.' }, output: 'a.txt' },
    },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Hello ',
    },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'world',
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 5 },
    },
  });
  tr.handleLine({
    event: 'result',
    result: { conversation_id: 'conv_abc', status: 'SUCCESS', response: 'Hello world' },
  });

  assert.equal(convId, 'conv_abc');
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'session.execution.started',
    'session.step.started',
    'session.tool.input.started',
    'session.tool.called',
    'session.tool.success',
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

  const msg = tr.toAssistantMessage();
  assert.equal(msg.model.providerID, 'agy-cli');
  assert.equal(msg.model.id, 'gemini-4-hydrogen-high');
  assert.equal(msg.tokens.input, 10);
  assert.equal(msg.tokens.output, 2);
  assert.equal(msg.tokens.reasoning, 1);
  assert.equal(msg.tokens.cache.read, 5);
  assert.equal(msg.content.length, 2);
  assert.equal(msg.content[0].type, 'tool');
  assert.equal(msg.content[0].state.status, 'completed');
  assert.equal(msg.content[1].type, 'text');
  assert.equal(msg.content[1].text, 'Hello world');
});

test('AgyTurnTranslator emits interrupted events on user cancel', () => {
  const events = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_2',
    assistantMessageID: 'msg_a2',
    modelID: 'gemini-3.8-flash-low',
    emit: (ev) => events.push(ev),
  });
  tr.begin();
  const msg = tr.interrupt('user');
  assert.equal(msg.finish, 'unknown');
  assert.ok(events.some((e) => e.type === 'session.execution.interrupted'));
  assert.ok(events.some((e) => e.type === 'session.idle'));
});

test('AgyTurnTranslator separates per-step window total, per-turn buckets, and cumulative session usage', () => {
  const turn1Events = [];
  const tr1 = new AgyTurnTranslator({
    sessionID: 'ses_usage',
    assistantMessageID: 'msg_u1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => turn1Events.push(ev),
  });

  // Step 1 emits both ACTIVE and DONE for the same step_index -> must overwrite, not double-count.
  tr1.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'checking ',
      usage: { input_tokens: 15504, output_tokens: 50, thinking_tokens: 40, cache_read_tokens: 0, total_tokens: 15554 },
    },
  });
  tr1.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'files',
      usage: { input_tokens: 15504, output_tokens: 236, thinking_tokens: 189, cache_read_tokens: 0, total_tokens: 15740 },
    },
  });
  // Step 3 after tool call hits prompt cache.
  tr1.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'done',
      usage: { input_tokens: 2381, output_tokens: 87, thinking_tokens: 82, cache_read_tokens: 13450, total_tokens: 2468 },
    },
  });
  tr1.handleLine({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'done',
      usage: { input_tokens: 17885, output_tokens: 323, thinking_tokens: 271, cache_read_tokens: 13450, total_tokens: 18208 },
    },
  });

  const msg1 = tr1.toAssistantMessage();
  assert.equal(msg1.tokens.total, 15918); // 2468 + 13450 (last step context window occupancy)
  assert.equal(msg1.tokens.input, 17885);
  assert.equal(msg1.tokens.output, 323);
  assert.equal(msg1.tokens.reasoning, 271);
  assert.equal(msg1.tokens.cache.read, 13450);

  const usageEvt1 = turn1Events.find((e) => e.type === 'session.usage.updated');
  assert.deepEqual(usageEvt1.data.tokens, {
    input: 17885,
    output: 323,
    reasoning: 271,
    cache: { read: 13450, write: 0 },
  });

  // Turn 2: `result.usage` accumulates Turn 1 + Turn 2, while message tokens must reflect ONLY Turn 2.
  const turn2Events = [];
  const tr2 = new AgyTurnTranslator({
    sessionID: 'ses_usage',
    assistantMessageID: 'msg_u2',
    modelID: 'gemini-4-hydrogen-high',
    priorSessionTokens: tr1.sessionTokens,
    priorResultUsage: tr1.rawResultUsage,
    emit: (ev) => turn2Events.push(ev),
  });

  tr2.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 5,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'step5',
      usage: { input_tokens: 2197, output_tokens: 41, thinking_tokens: 0, cache_read_tokens: 13171, total_tokens: 2238 },
    },
  });
  tr2.handleLine({
    event: 'step_update',
    step_update: {
      step_index: 7,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'ok',
      usage: { input_tokens: 2198, output_tokens: 75, thinking_tokens: 0, cache_read_tokens: 13327, total_tokens: 2273 },
    },
  });
  tr2.handleLine({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'ok',
      usage: { input_tokens: 22280, output_tokens: 439, thinking_tokens: 271, cache_read_tokens: 39948, total_tokens: 22719 },
    },
  });

  const msg2 = tr2.toAssistantMessage();
  assert.equal(msg2.tokens.total, 15600); // 2273 + 13327 (last step only, NOT 62K!)
  assert.equal(msg2.tokens.input, 4395); // 2197 + 2198 (Turn 2 only!)
  assert.equal(msg2.tokens.output, 116); // 41 + 75
  assert.equal(msg2.tokens.cache.read, 26498); // 13171 + 13327

  const usageEvt2 = turn2Events.find((e) => e.type === 'session.usage.updated');
  assert.deepEqual(usageEvt2.data.tokens, {
    input: 22280,
    output: 439,
    reasoning: 271,
    cache: { read: 39948, write: 0 },
  });
});

test('AgyTurnTranslator diffs result.usage against priorResultUsage when step_update lacks usage', () => {
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_fallback',
    assistantMessageID: 'msg_fb',
    modelID: 'gemini-3.8-flash-low',
    priorSessionTokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 500, write: 0 } },
    priorResultUsage: { input: 1000, output: 100, reasoning: 0, cache: { read: 500, write: 0 } },
    emit: () => {},
  });
  tr.handleLine({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'ok',
      usage: { input_tokens: 1200, output_tokens: 120, thinking_tokens: 10, cache_read_tokens: 900 },
    },
  });
  const msg = tr.toAssistantMessage();
  assert.equal(msg.tokens.input, 200);
  assert.equal(msg.tokens.output, 20);
  assert.equal(msg.tokens.reasoning, 10);
  assert.equal(msg.tokens.cache.read, 400);
  assert.equal(msg.tokens.total, 630);
  assert.deepEqual(tr.sessionTokens, {
    input: 1200,
    output: 120,
    reasoning: 10,
    cache: { read: 900, write: 0 },
  });
});

test('AgyTurnTranslator.emitReasoning emits reasoning SSE and preserves content ordering without colliding with activeTextSteps', () => {
  const events = [];
  const tr = new AgyTurnTranslator({
    sessionID: 'ses_r',
    assistantMessageID: 'msg_r1',
    modelID: 'gemini-4-hydrogen-high',
    emit: (ev) => events.push(ev),
    onSyncThinking: (stepIndex) => {
      if (stepIndex === 1) tr.emitReasoning(1, 'Plan tool read first.');
      if (stepIndex === 3) tr.emitReasoning(3, 'Summarize file content.');
    },
  });
  tr.begin();
  tr.handleLine({
    event: 'step_update',
    step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { thinking_tokens: 50 } },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: 'a.txt' } } },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: 'a.txt' }, output: 'ok' } },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Done.' },
  });
  tr.handleLine({
    event: 'step_update',
    step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '' },
  });
  tr.handleLine({ event: 'result', result: { status: 'SUCCESS', response: 'Done.' } });

  const msg = tr.toAssistantMessage();
  assert.deepEqual(
    msg.content.map((c) => c.type),
    ['reasoning', 'tool', 'reasoning', 'text'],
  );
  assert.equal(msg.content[0].text, 'Plan tool read first.');
  assert.equal(msg.content[2].text, 'Summarize file content.');
  assert.equal(msg.content[3].text, 'Done.');
  assert.equal(events.filter((e) => e.type === 'session.reasoning.ended').length, 2);
});
