import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStore } from '../src/gateway/store.mjs';

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

test('RouterStore.paginateMessages defaults to newest-first (desc) and traverses cursor.next / cursor.previous cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-router-page-'));
  try {
    const store = new RouterStore(dir);
    for (let i = 2; i <= 6; i += 1) {
      store.upsertMessage('ses_page', {
        id: `msg_${i}`,
        type: i % 2 === 0 ? 'user' : 'assistant',
        time: { created: i * 100 },
        text: `m${i}`,
      });
    }
    const upstream = [
      { id: 'msg_1', type: 'user', time: { created: 100 }, text: 'm1' },
      { id: 'msg_7', type: 'assistant', time: { created: 700 }, content: [] },
    ];

    // Default order is desc (newest first) -> returns msg_7, msg_6, msg_5
    const page1 = store.paginateMessages(upstream, 'ses_page', { limit: 3 });
    assert.deepEqual(page1.data.map((m) => m.id), ['msg_7', 'msg_6', 'msg_5']);
    assert.equal(page1.cursor.previous, undefined);
    assert.ok(page1.cursor.next);

    // Next page in desc -> older messages msg_4, msg_3, msg_2
    const page2 = store.paginateMessages(upstream, 'ses_page', { limit: 3, cursor: page1.cursor.next });
    assert.deepEqual(page2.data.map((m) => m.id), ['msg_4', 'msg_3', 'msg_2']);
    assert.ok(page2.cursor.previous);
    assert.ok(page2.cursor.next);

    // Previous from page2 walks back to newer messages msg_7, msg_6, msg_5
    const backToPage1 = store.paginateMessages(upstream, 'ses_page', { limit: 3, cursor: page2.cursor.previous });
    assert.deepEqual(backToPage1.data.map((m) => m.id), ['msg_7', 'msg_6', 'msg_5']);

    // Last page in desc -> oldest msg_1, no further next cursor
    const page3 = store.paginateMessages(upstream, 'ses_page', { limit: 3, cursor: page2.cursor.next });
    assert.deepEqual(page3.data.map((m) => m.id), ['msg_1']);
    assert.ok(page3.cursor.previous);
    assert.equal(page3.cursor.next, undefined);

    // Explicit asc order
    const ascPage = store.paginateMessages(upstream, 'ses_page', { limit: 2, order: 'asc' });
    assert.deepEqual(ascPage.data.map((m) => m.id), ['msg_1', 'msg_2']);
    assert.equal(ascPage.cursor.previous, undefined);
    assert.ok(ascPage.cursor.next);

    // Invalid cursor flagged cleanly
    const bad = store.paginateMessages(upstream, 'ses_page', { cursor: 'not-valid-cursor' });
    assert.equal(bad.invalidCursor, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
