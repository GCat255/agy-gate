import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGY_PROVIDER_ID } from './agy-models.mjs';
import { computeStepWindowTotal, emptyTokenBuckets, normalizeUsageBuckets } from './event-translator.mjs';

export const AGY_SUBAGENT_SESSION_PREFIX = 'agy_sub_';

/** @param {string} agyConversationId */
export function toChildSessionID(agyConversationId) {
  const id = String(agyConversationId || '').trim();
  if (!id) return '';
  return id.startsWith(AGY_SUBAGENT_SESSION_PREFIX) ? id : `${AGY_SUBAGENT_SESSION_PREFIX}${id}`;
}

/** @param {string} sessionID */
export function isAgyChildSessionID(sessionID) {
  return typeof sessionID === 'string' && sessionID.startsWith(AGY_SUBAGENT_SESSION_PREFIX);
}

/** @param {string | null | undefined} uri */
export function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  return trimmed;
}

function parseJsonArgValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}

function normalizeTranscriptToolArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const parsed = parseJsonArgValue(v);
    if (k === 'Path' && typeof parsed === 'string') out.path = parsed;
    else if (k === 'CommandLine' && typeof parsed === 'string') out.command = parsed;
    else out[k] = parsed;
  }
  return out;
}

function extractUserPromptFromTranscriptSystem(content) {
  const text = String(content || '');
  const match = text.match(/content=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/);
  return (match ? match[1] : text).trim();
}

function extractFollowUpPromptFromSystem(content) {
  const text = String(content || '');
  const msgMatch = text.match(/\[Message\]([\s\S]*?)\n<\/SYSTEM_MESSAGE>/);
  if (!msgMatch) return null;
  const senderMatch = msgMatch[1].match(/\bsender=([^\s]+)/);
  if (senderMatch?.[1] === 'system') return null;
  const contentMatch = msgMatch[1].match(/\bcontent=([\s\S]*)$/);
  return contentMatch ? contentMatch[1].trim() : null;
}

/**
 * Read non-empty JSON entries from a `transcript.jsonl` file.
 * @param {string | null | undefined} transcriptPath
 * @returns {any[] | null}
 */
export function readTranscriptLines(transcriptPath) {
  if (!transcriptPath) return null;
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

function addBuckets(a, b) {
  return {
    input: (a?.input || 0) + (b?.input || 0),
    output: (a?.output || 0) + (b?.output || 0),
    reasoning: (a?.reasoning || 0) + (b?.reasoning || 0),
    cache: {
      read: (a?.cache?.read || 0) + (b?.cache?.read || 0),
      write: (a?.cache?.write || 0) + (b?.cache?.write || 0),
    },
  };
}

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build OpenChamber-compatible background subagent completion synthetic message (`readSubagentRun`).
 * @param {{ childSessionID: string, agent?: string, title?: string, state: 'completed'|'error'|'cancelled', output: string, created?: number }} params
 */
export function buildSubagentCompletionSynthetic(params) {
  const created = params.created ?? Date.now();
  const state = params.state || 'completed';
  const attrs = [
    `sessionID="${escapeXmlAttr(params.childSessionID)}"`,
    `state="${escapeXmlAttr(state)}"`,
    ...(params.title ? [`description="${escapeXmlAttr(params.title)}"`] : []),
  ].join(' ');
  const body = String(params.output || '').trim() || (state === 'completed' ? 'Subagent completed.' : `Subagent ${state}.`);

  return {
    id: `msg_${created}_sub_${Math.random().toString(36).slice(2, 8)}`,
    type: 'synthetic',
    time: { created },
    text: `<subagent ${attrs}>\n${body}\n</subagent>`,
    ...(params.title ? { description: params.title } : {}),
    metadata: {
      source: 'subagent',
      childID: params.childSessionID,
      ...(params.agent ? { agent: params.agent } : {}),
      state,
    },
  };
}

/**
 * Incrementally translate `agy` subagent `transcript.jsonl` entries into OpenCode 2.3.2
 * child session messages and live SSE events.
 */
export class AgyTranscriptTranslator {
  /**
   * @param {{
   *   childSessionID: string,
   *   parentConversationId?: string,
   *   agent?: string,
   *   modelID?: string,
   *   directory?: string | null,
   *   emit?: (event: any) => void,
   * }} options
   */
  constructor(options) {
    this.childSessionID = options.childSessionID;
    this.parentConversationId = options.parentConversationId || '';
    this.agent = options.agent || 'subagent';
    this.modelID = options.modelID || 'agy-subagent';
    this.directory = options.directory || null;
    this.emit = options.emit || (() => {});
    this.onTurnStarted = options.onTurnStarted;

    this.processedSteps = new Set();
    this.messages = [];
    this.assistantMsg = null;
    this.pendingToolCalls = [];
    this.toolPartsByCallId = new Map();
    this.turnBuckets = emptyTokenBuckets();
    this.sessionBuckets = emptyTokenBuckets();
    this.lastWindowTotal = 0;
    this.tokens = emptyTokenBuckets();
    this.textOrdinal = 0;
    this.reasoningOrdinal = 0;
    this.finalOutput = '';
    this.repliedToParent = false;
    this.turnIndex = 0;
    this.turnActive = false;
    this.completed = false;
  }

  _send(type, data, created = Date.now()) {
    this.emit({
      type,
      created,
      ...(this.directory ? { location: { directory: this.directory } } : {}),
      data,
    });
  }

  _nextTimestamp(ts) {
    const prevCreated = this.messages.length > 0 ? (this.messages[this.messages.length - 1]?.time?.created ?? 0) : 0;
    return Math.max(ts, prevCreated + 1);
  }

  _pushUserMessage(ts, promptText, emitTurnStart = false) {
    const created = this._nextTimestamp(ts);
    if (emitTurnStart && this.onTurnStarted) {
      this.onTurnStarted({ turnIndex: this.turnIndex, created });
    }
    const msgId = `msg_${created}_sub${this.messages.length}`;
    this.messages.push({
      id: msgId,
      type: 'user',
      time: { created },
      text: promptText,
    });
    this._send(
      'session.inbox.enqueued',
      {
        sessionID: this.childSessionID,
        inboxID: msgId,
        item: { type: 'user', payload: { text: promptText } },
      },
      created,
    );
    this._send(
      'session.inbox.delivered',
      { sessionID: this.childSessionID, inboxID: msgId },
      created,
    );
  }

  _ensureAssistant(ts, modelID) {
    if (this.assistantMsg) return this.assistantMsg;
    const created = this._nextTimestamp(ts);
    const msgId = `msg_${created}_sub${this.messages.length}`;
    const resolvedModel = modelID || this.modelID;
    this.assistantMsg = {
      id: msgId,
      type: 'assistant',
      time: { created },
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: resolvedModel,
      },
      finish: 'stop',
      cost: 0,
      tokens: this.tokens,
      content: [],
    };
    this.messages.push(this.assistantMsg);
    this._send(
      'session.step.started',
      {
        sessionID: this.childSessionID,
        assistantMessageID: msgId,
        agent: this.agent,
        model: {
          providerID: AGY_PROVIDER_ID,
          id: resolvedModel,
        },
      },
      created,
    );
    return this.assistantMsg;
  }

  /**
   * Process one parsed JSON record from `transcript.jsonl`.
   * @param {any} entry
   */
  handleEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    const stepKey = Number.isInteger(entry.step_index) ? entry.step_index : null;
    if (stepKey !== null && entry.status === 'DONE') {
      if (this.processedSteps.has(stepKey)) return;
      this.processedSteps.add(stepKey);
    } else if (stepKey !== null && entry.status && entry.status !== 'DONE') {
      return;
    }

    const ts = entry.created_at ? Date.parse(entry.created_at) || Date.now() : Date.now();

    if (entry.step_index === 0 || entry.type === 'SYSTEM_MESSAGE') {
      if (this.messages.length === 0) {
        const promptText = extractUserPromptFromTranscriptSystem(entry.content);
        if (promptText) {
          this.turnIndex = 1;
          this.turnActive = true;
          this._pushUserMessage(ts, promptText, false);
        }
        return;
      }

      const followUpText = extractFollowUpPromptFromSystem(entry.content);
      if (!followUpText) return;

      if (this.assistantMsg || this.turnActive) {
        this.finalize('succeeded');
      }
      this.assistantMsg = null;
      this.pendingToolCalls = [];
      this.turnBuckets = emptyTokenBuckets();
      this.lastWindowTotal = 0;
      this.tokens = emptyTokenBuckets();
      this.textOrdinal = 0;
      this.reasoningOrdinal = 0;
      this.finalOutput = '';
      this.repliedToParent = false;
      this.completed = false;
      this.turnActive = true;
      this.turnIndex += 1;
      this._pushUserMessage(ts, followUpText, true);
      return;
    }

    if (entry.type === 'PLANNER_RESPONSE') {
      if (entry.model && !this.assistantMsg) {
        this.modelID = String(entry.model);
      }
      const msg = this._ensureAssistant(ts, entry.model);
      this.turnActive = true;
      const usage = normalizeUsageBuckets(entry);
      if (usage) {
        this.turnBuckets = addBuckets(this.turnBuckets, usage);
        this.sessionBuckets = addBuckets(this.sessionBuckets, usage);
        this.lastWindowTotal = computeStepWindowTotal(usage);
        this.tokens = this.lastWindowTotal > 0 ? { total: this.lastWindowTotal, ...this.turnBuckets } : this.turnBuckets;
        msg.tokens = this.tokens;
      }

      if (typeof entry.thinking === 'string' && entry.thinking.trim()) {
        const thinkingText = entry.thinking.trim();
        const rOrdinal = this.reasoningOrdinal++;
        this._send('session.reasoning.started', { sessionID: this.childSessionID, assistantMessageID: msg.id, ordinal: rOrdinal }, ts);
        this._send('session.reasoning.delta', { sessionID: this.childSessionID, assistantMessageID: msg.id, ordinal: rOrdinal, delta: thinkingText }, ts);
        this._send('session.reasoning.ended', { sessionID: this.childSessionID, assistantMessageID: msg.id, ordinal: rOrdinal, text: thinkingText }, ts);
        msg.content.push({ type: 'reasoning', text: thinkingText, time: { created: ts, completed: ts } });
      }

      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      for (let i = 0; i < toolCalls.length; i += 1) {
        const tc = toolCalls[i];
        if (!tc?.name) continue;
        const callID = `call_${msg.id}_${entry.step_index}_${i}`;
        const input = normalizeTranscriptToolArgs(tc.args);
        const toolName = String(tc.name);

        if (
          toolName === 'send_message' &&
          (!this.parentConversationId || String(input.Recipient || '') === this.parentConversationId) &&
          typeof input.Message === 'string' &&
          input.Message.trim()
        ) {
          this.finalOutput = input.Message.trim();
          this.repliedToParent = true;
        }

        this._send(
          'session.tool.input.started',
          { sessionID: this.childSessionID, assistantMessageID: msg.id, id: callID, name: toolName },
          ts,
        );
        this._send(
          'session.tool.called',
          { sessionID: this.childSessionID, assistantMessageID: msg.id, id: callID, input, executed: true },
          ts,
        );

        const part = {
          type: 'tool',
          id: callID,
          name: toolName,
          executed: true,
          time: { created: ts, ran: ts, completed: ts },
          state: { status: 'completed', input, content: [] },
        };
        msg.content.push(part);
        this.pendingToolCalls.push({ callID, name: toolName, input, part, startedAt: ts });
        this.toolPartsByCallId.set(callID, part);
      }

      if (typeof entry.content === 'string' && entry.content.trim()) {
        const text = entry.content.trim();
        const ordinal = this.textOrdinal++;
        this._send('session.text.started', { sessionID: this.childSessionID, assistantMessageID: msg.id, ordinal }, ts);
        this._send('session.text.delta', { sessionID: this.childSessionID, assistantMessageID: msg.id, ordinal, delta: text }, ts);
        this._send('session.text.ended', { sessionID: this.childSessionID, assistantMessageID: msg.id, ordinal, text }, ts);
        msg.content.push({ type: 'text', text });
        if (!this.repliedToParent || toolCalls.length === 0) {
          if (!this.finalOutput || toolCalls.length === 0) {
            this.finalOutput = text;
          }
        }
      }

      if (toolCalls.length === 0 && typeof entry.content === 'string' && entry.content.trim()) {
        this.completed = true;
      }
      return;
    }

    if (entry.type === 'GENERIC' && this.pendingToolCalls.length > 0) {
      const pending = this.pendingToolCalls.shift();
      const output = typeof entry.content === 'string' ? entry.content : '';
      const contentItems = output ? [{ type: 'text', text: output }] : [];
      pending.part.time.completed = ts;
      pending.part.state.content = contentItems;
      this._send(
        'session.tool.success',
        {
          sessionID: this.childSessionID,
          assistantMessageID: this.assistantMsg.id,
          id: pending.callID,
          content: contentItems,
          executed: true,
        },
        ts,
      );
    }
  }

  /** Whether the current turn already replied to parent via `send_message` with no open tools. */
  isReadyToSettleAfterReply() {
    return this.turnActive && !this.completed && this.repliedToParent && this.pendingToolCalls.length === 0;
  }

  /**
   * Close any remaining unconfirmed tool outputs and emit terminal step/usage events for the current turn.
   * @param {'succeeded'|'failed'|'interrupted'} [outcome]
   */
  finalize(outcome = 'succeeded') {
    if (!this.turnActive && !this.assistantMsg) {
      this.completed = true;
      return;
    }
    const now = Date.now();
    while (this.pendingToolCalls.length > 0) {
      const pending = this.pendingToolCalls.shift();
      pending.part.time.completed = now;
      if (this.assistantMsg) {
        this._send(
          'session.tool.success',
          {
            sessionID: this.childSessionID,
            assistantMessageID: this.assistantMsg.id,
            id: pending.callID,
            content: [],
            executed: true,
          },
          now,
        );
      }
    }

    if (this.assistantMsg) {
      const hasText = this.assistantMsg.content.some((p) => p?.type === 'text' && String(p.text || '').trim().length > 0);
      if (!hasText && this.repliedToParent && this.finalOutput) {
        const ordinal = this.textOrdinal++;
        this._send('session.text.started', { sessionID: this.childSessionID, assistantMessageID: this.assistantMsg.id, ordinal }, now);
        this._send('session.text.delta', { sessionID: this.childSessionID, assistantMessageID: this.assistantMsg.id, ordinal, delta: this.finalOutput }, now);
        this._send('session.text.ended', { sessionID: this.childSessionID, assistantMessageID: this.assistantMsg.id, ordinal, text: this.finalOutput }, now);
        this.assistantMsg.content.push({ type: 'text', text: this.finalOutput });
      }

      this.assistantMsg.time.completed = now;
      this.assistantMsg.finish = outcome === 'failed' ? 'error' : outcome === 'interrupted' ? 'unknown' : 'stop';
      this._send(
        'session.step.ended',
        {
          sessionID: this.childSessionID,
          assistantMessageID: this.assistantMsg.id,
          finish: this.assistantMsg.finish,
          cost: 0,
          tokens: this.tokens,
        },
        now,
      );
      this._send(
        'session.usage.updated',
        {
          sessionID: this.childSessionID,
          cost: 0,
          tokens: this.sessionBuckets,
        },
        now,
      );
      this.assistantMsg = null;
    }
    this.turnActive = false;
    this.completed = true;
  }
}

/**
 * Tail a subagent's `transcript.jsonl` across initial and follow-up (`send_message`) turns.
 */
export class AgySubagentWatcher {
  /**
   * @param {{
   *   childSessionID: string,
   *   parentSessionID: string,
   *   parentConversationId?: string,
   *   agent?: string,
   *   title?: string,
   *   modelID?: string,
   *   directory?: string | null,
   *   transcriptPath: string | null,
   *   store: import('./store.mjs').RouterStore,
   *   emit: (event: any) => void,
   *   onComplete?: (info: { childSessionID: string, state: 'completed'|'error'|'cancelled', output: string, tokens: any }) => void,
   *   pollMs?: number,
   *   replySettleMs?: number,
   *   initialSyncedLineCount?: number,
   * }} options
   */
  constructor(options) {
    this.childSessionID = options.childSessionID;
    this.parentSessionID = options.parentSessionID;
    this.agent = options.agent || 'subagent';
    this.title = options.title || this.agent;
    this.directory = options.directory || null;
    this.transcriptPath = options.transcriptPath;
    this.store = options.store;
    this.emit = options.emit;
    this.onComplete = options.onComplete;
    this.pollMs = options.pollMs ?? 200;
    this.replySettleMs = options.replySettleMs ?? 500;

    this._suppressEmit = false;
    this.translator = new AgyTranscriptTranslator({
      childSessionID: this.childSessionID,
      parentConversationId: options.parentConversationId,
      agent: this.agent,
      modelID: options.modelID,
      directory: this.directory,
      emit: (ev) => {
        if (!this._suppressEmit) this.emit(ev);
      },
      onTurnStarted: ({ created }) => this._handleTurnStarted(created),
    });
    this.timer = null;
    this.replySettleTimer = null;
    this.closed = false;
    this.turnBusy = true;
    this.turnSettled = false;
    this.initialTurnReported = (options.initialSyncedLineCount ?? 0) > 0;
    this.lastLineCount = 0;

    if (options.initialSyncedLineCount > 0 && this.transcriptPath) {
      this._catchUpSilently(options.initialSyncedLineCount);
    }
  }

  get settled() {
    return this.turnSettled;
  }

  set settled(val) {
    this.turnSettled = Boolean(val);
  }

  _catchUpSilently(upToLineCount) {
    const lines = readTranscriptLines(this.transcriptPath);
    if (!lines || lines.length === 0) return;
    const limit = Math.min(upToLineCount, lines.length);
    this._suppressEmit = true;
    try {
      for (let i = 0; i < limit; i += 1) {
        try {
          this.translator.handleEntry(JSON.parse(lines[i]));
        } catch {}
      }
      if (this.translator.completed || this.translator.isReadyToSettleAfterReply()) {
        this.translator.finalize('succeeded');
        this.turnBusy = false;
        this.turnSettled = true;
      }
      this.lastLineCount = limit;
    } finally {
      this._suppressEmit = false;
    }
  }

  _handleTurnStarted(created) {
    this._clearReplySettleTimer();
    this.turnBusy = true;
    this.turnSettled = false;
    if (this._suppressEmit) return;
    this.store.updateChildSession(this.childSessionID, {
      busy: true,
      outcome: null,
      time: { updated: created, idle: null },
    });
    const loc = this.directory ? { location: { directory: this.directory } } : {};
    this.emit({
      type: 'session.execution.started',
      created,
      ...loc,
      data: { sessionID: this.childSessionID },
    });
    this._ensurePollTimer();
  }

  _ensurePollTimer() {
    if (this.closed || this.timer || !this.transcriptPath) return;
    this.timer = setInterval(() => this.flush(), this.pollMs);
    this.timer.unref?.();
  }

  _clearReplySettleTimer() {
    if (this.replySettleTimer) {
      clearTimeout(this.replySettleTimer);
      this.replySettleTimer = null;
    }
  }

  _scheduleReplySettle() {
    if (this.closed || !this.turnBusy || this.replySettleTimer || this._suppressEmit) return;
    this.replySettleTimer = setTimeout(() => {
      this.replySettleTimer = null;
      this.flush({ settleReplyNow: true });
    }, this.replySettleMs);
    this.replySettleTimer.unref?.();
  }

  pausePolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._clearReplySettleTimer();
  }

  start() {
    if (this.closed || !this.transcriptPath) return;
    this.flush();
    if (!this.closed && this.turnBusy) {
      this._ensurePollTimer();
    }
  }

  resume() {
    if (this.closed || !this.transcriptPath) return false;
    this._clearReplySettleTimer();
    this.flush();
    if (!this.closed && (this.turnBusy || !this.turnSettled)) {
      this._ensurePollTimer();
    } else if (!this.closed) {
      // Child was sleeping and about to receive a follow-up send_message
      this._ensurePollTimer();
    }
    return true;
  }

  /** @param {{ settleReplyNow?: boolean }} [options] */
  flush(options = {}) {
    if (this.closed || !this.transcriptPath) return false;
    const lines = readTranscriptLines(this.transcriptPath);
    if (!lines) return false;

    if (lines.length > this.lastLineCount) {
      this._clearReplySettleTimer();
      for (let i = this.lastLineCount; i < lines.length; i += 1) {
        try {
          const entry = JSON.parse(lines[i]);
          this.translator.handleEntry(entry);
        } catch {
          // Ignore partial line while writer flushes
        }
      }
      this.lastLineCount = lines.length;
      this.store.replaceChildMessages(this.childSessionID, this.translator.messages);
      this.store.updateChildSession(this.childSessionID, {
        tokens: this.translator.sessionBuckets,
        model: { providerID: AGY_PROVIDER_ID, id: this.translator.modelID },
        lastSyncedLineCount: this.lastLineCount,
        time: { updated: Date.now() },
      });
    }

    if (this.translator.completed && (this.turnBusy || this.translator.assistantMsg)) {
      this.finish('completed');
      return true;
    }

    if (this.translator.isReadyToSettleAfterReply()) {
      if (options.settleReplyNow) {
        this.finish('completed');
        return true;
      }
      this._scheduleReplySettle();
    }
    return false;
  }

  /**
   * Settle the currently active turn (`sleeping` ready for follow-up `send_message` turns).
   * @param {'completed'|'error'|'cancelled'} [state]
   * @param {string} [overrideOutput]
   */
  finish(state = 'completed', overrideOutput) {
    if (this.turnSettled && !this.turnBusy) return;
    this.pausePolling();

    // Read any trailing lines once before settling this turn
    if (this.transcriptPath) {
      const lines = readTranscriptLines(this.transcriptPath);
      if (lines && lines.length > this.lastLineCount) {
        for (let i = this.lastLineCount; i < lines.length; i += 1) {
          try {
            this.translator.handleEntry(JSON.parse(lines[i]));
          } catch {}
        }
        this.lastLineCount = lines.length;
      }
    }

    this.turnBusy = false;
    this.turnSettled = true;

    const execOutcome = state === 'error' ? 'failed' : state === 'cancelled' ? 'interrupted' : 'succeeded';
    this.translator.finalize(execOutcome);
    this.store.replaceChildMessages(this.childSessionID, this.translator.messages);

    const now = Date.now();
    this.store.updateChildSession(this.childSessionID, {
      busy: false,
      outcome: execOutcome,
      tokens: this.translator.sessionBuckets,
      model: { providerID: AGY_PROVIDER_ID, id: this.translator.modelID },
      lastSyncedLineCount: this.lastLineCount,
      time: { updated: now, idle: now },
    });

    const loc = this.directory ? { location: { directory: this.directory } } : {};
    this.emit({
      type: `session.execution.${execOutcome}`,
      created: now,
      ...loc,
      data: { sessionID: this.childSessionID },
    });
    this.emit({
      type: 'session.idle',
      created: now,
      ...loc,
      data: { sessionID: this.childSessionID },
    });

    const output = overrideOutput || this.translator.finalOutput || '';
    if (!this.initialTurnReported) {
      this.initialTurnReported = true;
      if (this.onComplete) {
        this.onComplete({
          childSessionID: this.childSessionID,
          state,
          output,
          tokens: this.translator.tokens,
        });
      }
    }
  }

  /**
   * Permanently terminate watching (e.g. `manage_subagents kill` / user interrupt / delete).
   * @param {'completed'|'error'|'cancelled'} [state]
   * @param {string} [overrideOutput]
   */
  close(state = 'completed', overrideOutput) {
    if (this.closed) return;
    this.pausePolling();
    this.flush({ settleReplyNow: true });
    this.closed = true;
    if (this.turnBusy) {
      const resolvedState = state === 'cancelled' && this.translator.repliedToParent ? 'completed' : state;
      this.finish(resolvedState, overrideOutput);
    }
  }
}

/**
 * Resolve `transcript.jsonl` under Antigravity's brain directory for any conversation ID.
 * @param {string | null | undefined} conversationId
 * @param {string} [homeDir]
 */
export function resolveBrainTranscriptPath(conversationId, homeDir = os.homedir()) {
  const convId = String(conversationId || '')
    .replace(/^agy_sub_/, '')
    .trim();
  if (!convId) return null;
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

/**
 * Resolve `transcript.jsonl` for a child session record, falling back to `agy`'s standard brain path
 * for pre-patch records created before `transcriptPath` persistence was added.
 * @param {any} childRecord
 * @param {string} [homeDir]
 */
export function resolveChildTranscriptPath(childRecord, homeDir = os.homedir()) {
  if (!childRecord) return null;
  if (childRecord.transcriptPath) return childRecord.transcriptPath;
  const candidate = resolveBrainTranscriptPath(childRecord.agyConversationId || childRecord.sessionID, homeDir);
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

/**
 * Re-sync a child session record directly from its `transcript.jsonl` on disk (catch-up when closed or restarted).
 * @param {{ childRecord: any, store: import('./store.mjs').RouterStore, homeDir?: string }} params
 */
export function syncChildSessionFromTranscript({ childRecord, store, homeDir }) {
  if (!childRecord?.isChild) return false;
  const transcriptPath = resolveChildTranscriptPath(childRecord, homeDir);
  if (!transcriptPath) return false;
  if (!childRecord.transcriptPath) {
    store.updateChildSession(childRecord.sessionID, { transcriptPath });
  }
  const lines = readTranscriptLines(transcriptPath);
  if (!lines || lines.length === 0) return false;

  const prevCount = childRecord.lastSyncedLineCount ?? 0;
  const hasUnclosedAssistant =
    !childRecord.busy &&
    Array.isArray(childRecord.messages) &&
    childRecord.messages.some((m) => m?.type === 'assistant' && !m?.time?.completed);
  if (prevCount > 0 && lines.length <= prevCount && !childRecord.busy && !hasUnclosedAssistant) {
    return false;
  }

  const parentConvId =
    childRecord.parentConversationId ||
    (childRecord.parentID ? store.getSession(childRecord.parentID)?.agyConversationId || '' : '');
  const translator = new AgyTranscriptTranslator({
    childSessionID: childRecord.sessionID,
    parentConversationId: parentConvId,
    agent: childRecord.agent || 'subagent',
    modelID: childRecord.model?.id || 'agy-subagent',
    directory: childRecord.directory || null,
    emit: () => {},
  });

  for (const line of lines) {
    try {
      translator.handleEntry(JSON.parse(line));
    } catch {}
  }

  const canSettle = translator.completed || (!childRecord.busy && (translator.turnActive || translator.isReadyToSettleAfterReply()));
  if (canSettle && (translator.turnActive || translator.assistantMsg)) {
    translator.finalize('succeeded');
  }

  const now = Date.now();
  store.replaceChildMessages(childRecord.sessionID, translator.messages);
  store.updateChildSession(childRecord.sessionID, {
    transcriptPath,
    ...(parentConvId ? { parentConversationId: parentConvId } : {}),
    busy: canSettle ? false : childRecord.busy,
    ...(canSettle ? { outcome: 'succeeded' } : {}),
    tokens: translator.sessionBuckets,
    model: { providerID: AGY_PROVIDER_ID, id: translator.modelID },
    lastSyncedLineCount: lines.length,
    time: {
      updated: now,
      ...(canSettle ? { idle: childRecord.idleAt || now } : {}),
    },
  });
  return true;
}
