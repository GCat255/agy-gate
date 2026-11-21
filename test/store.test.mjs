import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStore } from '../src/store.mjs';

test('RouterStore persists session overrides and merges messages chronologically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-router-store-'));
  try {
    const store = new RouterStore(dir);
    store.setSessionDirectory('ses_1', 'E:/repo');
    store.setSessionModel('ses_1', { providerID: 'agy-cli', id: 'gemini-4-neon-high' });
    store.setAgyConversationId('ses_1', 'conv_999');
    store.recordTurnUsage('ses_1', {
      sessionTokens: { input: 1200, output: 50, reasoning: 10, cache: { read: 800, write: 0 } },
      lastResultUsage: { input: 1200, output: 50, reasoning: 10, cache: { read: 800, write: 0 } },
    });

    store.upsertMessage('ses_1', {
      id: 'msg_2',
      type: 'user',
      time: { created: 200 },
      text: 'from agy',
    });

    const reloaded = new RouterStore(dir);
    const info = reloaded.overlaySessionInfo({
      id: 'ses_1',
      title: 'Test',
      time: { created: 100, updated: 150 },
      location: { directory: 'E:/repo' },
    });
    assert.equal(info.model.providerID, 'agy-cli');
    assert.equal(info.model.id, 'gemini-4-neon-high');
    assert.deepEqual(info.tokens, { input: 1200, output: 50, reasoning: 10, cache: { read: 800, write: 0 } });
    assert.equal(reloaded.getSession('ses_1').agyConversationId, 'conv_999');

    const merged = reloaded.mergeMessages(
      [
        { id: 'msg_1', type: 'user', time: { created: 100 }, text: 'from opencode' },
        { id: 'msg_3', type: 'assistant', time: { created: 300 }, content: [] },
      ],
      'ses_1',
    );
    assert.deepEqual(
      merged.map((m) => m.id),
      ['msg_1', 'msg_2', 'msg_3'],
    );

    reloaded.deleteSession('ses_1');
    assert.equal(reloaded.getSession('ses_1'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
