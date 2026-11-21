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
