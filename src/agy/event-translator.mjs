import { AGY_PROVIDER_ID } from './models.mjs';
import {
  buildAcpToolResult,
  mergeAcpToolSnapshot,
  normalizeAcpToolInvocation,
  unwrapToolParamValue,
} from './tool-adapter.mjs';

export function computeStepWindowTotal(parsed) {
  if (!parsed || typeof parsed !== 'object') return 0;
  return parsed.windowTotal || 0;
}

export function normalizeUsageBuckets(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const input = num(usage.input_tokens ?? usage.inputTokens ?? usage.input);
  const output = num(usage.output_tokens ?? usage.outputTokens ?? usage.output);
  const reasoning = num(usage.thinking_tokens ?? usage.thoughtTokens ?? usage.reasoning);
  const cacheRead = num(usage.cache_read_tokens ?? usage.cachedReadTokens ?? usage.cache?.read);
  const cacheWrite = num(usage.cache_write_tokens ?? usage.cachedWriteTokens ?? usage.cache?.write);
  const hasAny =
    typeof usage.input_tokens === 'number' ||
    typeof usage.inputTokens === 'number' ||
    typeof usage.output_tokens === 'number' ||
    typeof usage.outputTokens === 'number' ||
    typeof usage.thinking_tokens === 'number' ||
    typeof usage.thoughtTokens === 'number' ||
    typeof usage.cache_read_tokens === 'number' ||
    typeof usage.cachedReadTokens === 'number' ||
    typeof usage.cache_write_tokens === 'number' ||
    typeof usage.cachedWriteTokens === 'number' ||
    typeof usage.total_tokens === 'number' ||
    typeof usage.totalTokens === 'number' ||
    typeof usage.input === 'number' ||
    typeof usage.output === 'number' ||
    typeof usage.reasoning === 'number';
  if (!hasAny) return null;

  const reportedTotal = num(usage.total_tokens ?? usage.totalTokens ?? usage.total);
  const baseTotal = reportedTotal > 0 ? Math.max(reportedTotal, input + output) : input + output + reasoning;
  const windowTotal = baseTotal + cacheRead + cacheWrite;

  return {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
    windowTotal,
  };
}

export function emptyTokenBuckets() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function addTokenBuckets(a, b) {
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

function extractAcpToolError(update, status, outputText) {
  const rawOutput = update?.rawOutput;
  if (rawOutput && typeof rawOutput === 'object') {
    if (typeof rawOutput.error === 'string' && rawOutput.error.trim()) return rawOutput.error.trim();
    if (typeof rawOutput.error?.message === 'string' && rawOutput.error.message.trim()) {
      return rawOutput.error.message.trim();
    }
  }
  if (status === 'failed' || status === 'error') {
    return outputText.trim() || 'Tool execution failed';
  }
  return '';
}

/**
 * Translate `agy acp` `session/update` notifications and `session/prompt` results
 * into OpenCode 2.3.2 `OpenCodeEvent` SSE events and persisted `SessionMessage.Assistant` records.
 */
export class AgyTurnTranslator {
  /**
   * @param {{
   *   sessionID: string,
   *   assistantMessageID: string,
   *   modelID: string,
   *   variant?: string,
   *   agent?: string,
   *   directory?: string | null,
   *   toolContract?: any,
   *   emit: (event: any) => void,
   *   onOpenChamberToolStart?: (info: { tool: string, callID: string }) => void,
   *   onSyncSubagents?: () => void,
   *   onSubagentWake?: (info: { recipientId: string }) => void,
   *   onSubagentKilled?: (info: { all: boolean, conversationIds: string[] }) => void,
   *   priorSessionTokens?: { input: number, output: number, reasoning: number, cache: { read: number, write: number } } | null,
   * }} options
   */
  constructor(options) {
    this.sessionID = options.sessionID;
    this.assistantMessageID = options.assistantMessageID;
    this.modelID = options.modelID;
    this.variant = options.variant;
    this.agent = options.agent || 'agy-cli';
    this.directory = options.directory || null;
    this.toolContract = options.toolContract || null;
    this.emit = options.emit;
    this.onOpenChamberToolStart = options.onOpenChamberToolStart;
    this.onSyncSubagents = options.onSyncSubagents;
    this.onSubagentWake = options.onSubagentWake;
    this.onSubagentKilled = options.onSubagentKilled;
    this.priorSessionTokens = options.priorSessionTokens || emptyTokenBuckets();

    this.created = Date.now();
    this.started = false;
    this.finished = false;
    this.firstTokenSent = false;
    this.textOrdinal = 0;
    this.reasoningOrdinal = 0;

    /** @type {{ kind: 'text'|'reasoning', ordinal: number, buffer: string } | null} */
    this.openStream = null;
    /** @type {Map<string, { callID: string, name: string, input: any, startedAt: number, closed: boolean, isOpenChamberTool: boolean }>} */
    this.activeTools = new Map();
    /** @type {Array<{ callID: string, input: any, childSessionID: string | null, startedAt: number, notified: boolean, closed: boolean }>} */
    this.activeSubagents = [];

    this.latestWindowUsed = 0;
    this.tokens = emptyTokenBuckets();
    this.sessionTokens = addTokenBuckets(this.priorSessionTokens, emptyTokenBuckets());
    /** @type {any[]} */
    this.content = [];
  }

  _location() {
    return this.directory ? { directory: this.directory } : undefined;
  }

  _send(type, data) {
    this.emit({
      type,
      created: Date.now(),
      ...(this._location() ? { location: this._location() } : {}),
      data,
    });
  }

  /** Start the turn and emit execution + step started events. */
  begin() {
    if (this.started) return;
    this.started = true;
    this._send('session.execution.started', { sessionID: this.sessionID });
    this._send('session.step.started', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: this.modelID,
        ...(this.variant ? { variant: this.variant } : {}),
      },
    });
  }

  _closeOpenStream() {
    const stream = this.openStream;
    if (!stream) return;
    this.openStream = null;
    this._send(stream.kind === 'text' ? 'session.text.ended' : 'session.reasoning.ended', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      ordinal: stream.ordinal,
      text: stream.buffer,
    });
    if (stream.kind === 'text') {
      this.content.push({ type: 'text', text: stream.buffer });
    } else {
      this.content.push({
        type: 'reasoning',
        text: stream.buffer,
        time: { created: this.created, completed: Date.now() },
      });
    }
  }

  /**
   * Append streaming text or reasoning delta from ACP chunk notifications.
   * @param {'text'|'reasoning'} kind
   * @param {string} delta
   */
  _appendStreamDelta(kind, delta) {
    if (typeof delta !== 'string' || delta.length === 0) return;

    if (!this.firstTokenSent) {
      this.firstTokenSent = true;
      this._send('session.step.first-token', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
      });
    }

    if (this.openStream && this.openStream.kind !== kind) {
      this._closeOpenStream();
    }

    if (!this.openStream) {
      const ordinal = kind === 'text' ? this.textOrdinal++ : this.reasoningOrdinal++;
      this.openStream = { kind, ordinal, buffer: '' };
      this._send(kind === 'text' ? 'session.text.started' : 'session.reasoning.started', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        ordinal,
      });
    }

    this.openStream.buffer += delta;
    this._send(kind === 'text' ? 'session.text.delta' : 'session.reasoning.delta', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      ordinal: this.openStream.ordinal,
      delta,
    });
  }

  /**
   * Process one `session/update` `params.update` payload from `agy acp`.
   * @param {any} update
   */
  handleAcpUpdate(update) {
    if (!update || typeof update !== 'object' || this.finished) return;
    this.begin();

    const kind = update.sessionUpdate;
    if (kind === 'agent_thought_chunk') {
      const text = update.content?.type === 'text' ? update.content.text : update.content?.text;
      if (typeof text === 'string') {
        this._appendStreamDelta('reasoning', text);
      }
      return;
    }

    if (kind === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? update.content.text : update.content?.text;
      if (typeof text === 'string') {
        this._appendStreamDelta('text', text);
      }
      return;
    }

    if (kind === 'usage_update') {
      if (typeof update.used === 'number' && Number.isFinite(update.used) && update.used >= 0) {
        this.latestWindowUsed = update.used;
      }
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this._handleAcpToolEvent(update);
    }
  }

  _handleAcpToolEvent(update) {
    this._closeOpenStream();

    const callID = String(update.toolCallId || `call_${this.assistantMessageID}_${this.activeTools.size}`);
    const existingTool = this.activeTools.get(callID);
    const snapshot = mergeAcpToolSnapshot(existingTool?.snapshot, update);
    const status = String(update.status || 'in_progress').toLowerCase();

    if (snapshot.name === 'invoke_subagent') {
      this._handleSubagentToolEvent(callID, snapshot.rawInput, status);
      return;
    }

    const normalized = normalizeAcpToolInvocation(snapshot, { contract: this.toolContract });
    const nextInputJson = JSON.stringify(normalized.input);
    const openchamberStartMeta = normalized.isOpenChamberTool
      ? {
          openchamber: {
            schemaVersion: 1,
            ...(typeof normalized.input.action === 'string' ? { action: normalized.input.action } : {}),
          },
        }
      : undefined;

    let tool = existingTool;
    if (!tool) {
      tool = {
        callID,
        name: normalized.name,
        rawName: normalized.rawName,
        input: normalized.input,
        inputJson: nextInputJson,
        snapshot,
        normalized,
        startedAt: Date.now(),
        closed: false,
        isOpenChamberTool: normalized.isOpenChamberTool,
      };
      this.activeTools.set(callID, tool);
      if (tool.isOpenChamberTool && this.onOpenChamberToolStart) {
        this.onOpenChamberToolStart({ tool: tool.name, callID });
      }
      this._send('session.tool.input.started', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: callID,
        name: tool.name,
      });
      this._send('session.tool.called', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: callID,
        input: tool.input,
        executed: true,
        ...(openchamberStartMeta ? { metadata: openchamberStartMeta } : {}),
      });
    } else if (!tool.closed) {
      tool.snapshot = snapshot;
      tool.normalized = normalized;
      tool.name = normalized.name;
      tool.rawName = normalized.rawName;
      if (nextInputJson !== tool.inputJson) {
        tool.input = normalized.input;
        tool.inputJson = nextInputJson;
        this._send('session.tool.called', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
          id: callID,
          input: tool.input,
          executed: true,
        });
      }
    }

    if (normalized.rawName === 'send_message' && this.onSubagentWake) {
      const recipientId = unwrapToolParamValue(snapshot.rawInput.Recipient ?? snapshot.rawInput.recipient);
      if (typeof recipientId === 'string' && recipientId.trim()) {
        this.onSubagentWake({ recipientId: recipientId.trim() });
      }
    }

    const terminal = status === 'completed' || status === 'failed' || status === 'error';
    if (!terminal || tool.closed) return;

    tool.closed = true;
    if (normalized.rawName === 'manage_subagents' && this.onSubagentKilled) {
      const action = String(unwrapToolParamValue(snapshot.rawInput.Action ?? snapshot.rawInput.action) || '').trim();
      if (action === 'kill_all') {
        this.onSubagentKilled({ all: true, conversationIds: [] });
      } else if (action === 'kill') {
        const rawIds = unwrapToolParamValue(snapshot.rawInput.ConversationIds ?? snapshot.rawInput.conversationIds);
        const conversationIds = Array.isArray(rawIds)
          ? rawIds.map((id) => String(unwrapToolParamValue(id) || '').trim()).filter(Boolean)
          : typeof rawIds === 'string' && rawIds.trim()
            ? [rawIds.trim()]
            : [];
        if (conversationIds.length > 0) {
          this.onSubagentKilled({ all: false, conversationIds });
        }
      }
    }

    const now = Date.now();
    const { outputText, contentItems, diffMeta } = buildAcpToolResult(update, tool.normalized);
    const errorMsg = extractAcpToolError(update, status, outputText);

    let mergedMeta = diffMeta ? { ...diffMeta } : undefined;
    if (tool.isOpenChamberTool) {
      let parsedOut = null;
      try {
        parsedOut = outputText ? JSON.parse(outputText) : null;
      } catch {}
      const ok = parsedOut?.schemaVersion === 1 ? Boolean(parsedOut.ok) : !errorMsg;
      const answer = parsedOut?.data?.answer && typeof parsedOut.data.answer === 'object' ? parsedOut.data.answer : undefined;
      mergedMeta = {
        ...mergedMeta,
        openchamber: {
          schemaVersion: 1,
          ...(typeof parsedOut?.action === 'string'
            ? { action: parsedOut.action }
            : typeof tool.input?.action === 'string'
              ? { action: tool.input.action }
              : {}),
          ok,
          ...(answer ? { answer } : {}),
        },
      };
    }

    if (errorMsg) {
      this._send('session.tool.failed', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: tool.callID,
        error: { type: 'unknown', message: errorMsg },
        content: contentItems,
        executed: true,
        ...(mergedMeta ? { metadata: mergedMeta } : {}),
      });
      this.content.push({
        type: 'tool',
        id: tool.callID,
        name: tool.name,
        executed: true,
        time: { created: tool.startedAt, ran: tool.startedAt, completed: now },
        state: {
          status: 'error',
          input: tool.input,
          error: { type: 'unknown', message: errorMsg },
          content: contentItems,
          ...(mergedMeta ? { metadata: mergedMeta } : {}),
        },
      });
    } else {
      this._send('session.tool.success', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: tool.callID,
        content: contentItems,
        executed: true,
        ...(mergedMeta ? { metadata: mergedMeta } : {}),
      });
      this.content.push({
        type: 'tool',
        id: tool.callID,
        name: tool.name,
        executed: true,
        time: { created: tool.startedAt, ran: tool.startedAt, completed: now },
        state: {
          status: 'completed',
          input: tool.input,
          content: contentItems,
          ...(mergedMeta ? { metadata: mergedMeta } : {}),
        },
      });
    }
  }

  _handleSubagentToolEvent(callID, parameters, status) {
    let entry = this.activeSubagents.find((s) => s.callID === callID);
    if (!entry) {
      const input = {
        agent: String(unwrapToolParamValue(parameters.TypeName ?? parameters.type_name) || 'subagent'),
        description: String(
          unwrapToolParamValue(parameters.Role ?? parameters.role ?? parameters.TypeName ?? parameters.type_name) || 'Subagent',
        ),
        prompt: String(unwrapToolParamValue(parameters.Prompt ?? parameters.initial_prompt) || ''),
      };
      entry = {
        callID,
        input,
        childSessionID: null,
        startedAt: Date.now(),
        notified: false,
        closed: false,
      };
      this.activeSubagents.push(entry);

      this._send('session.tool.input.started', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: callID,
        name: 'subagent',
      });
      this._send('session.tool.called', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: callID,
        input,
        executed: true,
      });
    }

    if ((status === 'completed' || status === 'failed' || status === 'error') && this.onSyncSubagents) {
      this.onSyncSubagents();
    }
  }

  /**
   * Bind a newly discovered `agy` subagent child session from main `transcript.jsonl`
   * to the oldest unbound `subagent` tool call in this turn.
   * @param {string} childSessionID
   */
  attachDiscoveredSubagent(childSessionID) {
    const entry = this.activeSubagents.find((s) => !s.notified && !s.closed);
    if (!entry) return false;
    entry.notified = true;
    entry.childSessionID = childSessionID;
    this._send('session.tool.progress', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      id: entry.callID,
      metadata: { sessionID: childSessionID },
    });
    return true;
  }

  /**
   * Complete an open `subagent` tool call inside this turn once the child finishes.
   * Returns `false` if this turn has already finished (caller should emit background synthetic completion).
   * @param {string} childSessionID
   * @param {{ state?: 'completed'|'error'|'cancelled', output?: string }} info
   */
  resolveSubagent(childSessionID, info = {}) {
    if (this.finished) return false;
    const entry = this.activeSubagents.find((item) => item.childSessionID === childSessionID && !item.closed);
    if (!entry) return false;

    entry.closed = true;
    const state = info.state || 'completed';
    const now = Date.now();
    const output = String(info.output || '');
    const contentItems = output ? [{ type: 'text', text: output }] : [];
    const metadata = { status: state, sessionID: childSessionID };

    if (state === 'error') {
      this._send('session.tool.failed', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: entry.callID,
        error: { type: 'unknown', message: output || 'Subagent failed' },
        content: contentItems,
        executed: true,
        metadata,
      });
      this.content.push({
        type: 'tool',
        id: entry.callID,
        name: 'subagent',
        executed: true,
        time: { created: entry.startedAt, ran: entry.startedAt, completed: now },
        state: {
          status: 'error',
          input: entry.input,
          error: { type: 'unknown', message: output || 'Subagent failed' },
          content: contentItems,
          metadata,
        },
      });
    } else {
      this._send('session.tool.success', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: entry.callID,
        content: contentItems,
        executed: true,
        metadata,
      });
      this.content.push({
        type: 'tool',
        id: entry.callID,
        name: 'subagent',
        executed: true,
        time: { created: entry.startedAt, ran: entry.startedAt, completed: now },
        state: {
          status: 'completed',
          input: entry.input,
          content: contentItems,
          metadata,
        },
      });
    }
    return true;
  }

  _flushOpenSubagents(interrupted = false) {
    const now = Date.now();
    for (const entry of this.activeSubagents) {
      if (entry.closed) continue;
      entry.closed = true;
      if (entry.childSessionID && !interrupted) {
        const metadata = { status: 'running', sessionID: entry.childSessionID };
        const contentItems = [{ type: 'text', text: 'Subagent running in background.' }];
        this._send('session.tool.success', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
          id: entry.callID,
          content: contentItems,
          executed: true,
          metadata,
        });
        this.content.push({
          type: 'tool',
          id: entry.callID,
          name: 'subagent',
          executed: true,
          time: { created: entry.startedAt, ran: entry.startedAt, completed: now },
          state: {
            status: 'completed',
            input: entry.input,
            content: contentItems,
            metadata,
          },
        });
      } else {
        const metadata = entry.childSessionID ? { status: 'cancelled', sessionID: entry.childSessionID } : undefined;
        this._send('session.tool.failed', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
          id: entry.callID,
          error: { type: 'unknown', message: interrupted ? 'Subagent interrupted' : 'Subagent did not report a session ID' },
          content: [],
          executed: true,
          ...(metadata ? { metadata } : {}),
        });
        this.content.push({
          type: 'tool',
          id: entry.callID,
          name: 'subagent',
          executed: true,
          time: { created: entry.startedAt, ran: entry.startedAt, completed: now },
          state: {
            status: 'error',
            input: entry.input,
            error: { type: 'unknown', message: interrupted ? 'Subagent interrupted' : 'Subagent did not report a session ID' },
            content: [],
            ...(metadata ? { metadata } : {}),
          },
        });
      }
    }
  }

  /**
   * Apply per-turn `usage` from `session/prompt` response and `latestWindowUsed` from `usage_update`.
   * @param {any} usage
   */
  recordPromptUsage(usage) {
    const parsed = normalizeUsageBuckets(usage);
    if (!parsed) return;
    const turnBuckets = {
      input: parsed.input,
      output: parsed.output,
      reasoning: parsed.reasoning,
      cache: { ...parsed.cache },
    };
    const windowTotal =
      this.latestWindowUsed > 0
        ? this.latestWindowUsed
        : parsed.input + parsed.output + parsed.cache.read + parsed.cache.write;
    this.tokens = windowTotal > 0 ? { total: windowTotal, ...turnBuckets } : turnBuckets;
    this.sessionTokens = addTokenBuckets(this.priorSessionTokens, turnBuckets);
  }

  /**
   * Finalize the turn using the `session/prompt` JSON-RPC result.
   * @param {any} result
   */
  completeFromPromptResult(result) {
    if (result?.usage) {
      this.recordPromptUsage(result.usage);
    } else if (this.latestWindowUsed > 0) {
      this.tokens = { total: this.latestWindowUsed, ...emptyTokenBuckets() };
    }

    if (result?.stopReason === 'cancelled') {
      return this.interrupt('user');
    }
    return this.complete();
  }

  /** Mark turn completed successfully and emit terminal OpenCode events. */
  complete() {
    if (this.finished) return;
    this._closeOpenStream();
    this._flushOpenSubagents(false);
    this.finished = true;
    const completed = Date.now();

    this._send('session.step.ended', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      finish: 'stop',
      cost: 0,
      tokens: this.tokens,
    });
    this._send('session.usage.updated', {
      sessionID: this.sessionID,
      cost: 0,
      tokens: this.sessionTokens,
    });
    this._send('session.execution.succeeded', { sessionID: this.sessionID });
    this._send('session.idle', { sessionID: this.sessionID });

    return this.toAssistantMessage('stop', undefined, completed);
  }

  /** @param {string} reason */
  interrupt(reason = 'user') {
    if (this.finished) return;
    this._closeOpenStream();
    this._flushOpenSubagents(true);
    this.finished = true;
    const completed = Date.now();

    this._send('session.step.ended', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      finish: 'unknown',
      cost: 0,
      tokens: this.tokens,
    });
    this._send('session.execution.interrupted', { sessionID: this.sessionID, reason });
    this._send('session.idle', { sessionID: this.sessionID });

    return this.toAssistantMessage('unknown', undefined, completed);
  }

  /** @param {string} message */
  fail(message) {
    if (this.finished) return;
    this._closeOpenStream();
    this._flushOpenSubagents(true);
    this.finished = true;
    const completed = Date.now();
    const errObj = { type: 'unknown', message: String(message || 'agy-cli error') };

    this._send('session.step.failed', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      finish: 'error',
      error: errObj,
      cost: 0,
      tokens: this.tokens,
    });
    this._send('session.execution.failed', {
      sessionID: this.sessionID,
      error: errObj,
    });
    this._send('session.idle', { sessionID: this.sessionID });

    return this.toAssistantMessage('error', errObj, completed);
  }

  /** Build the persisted `SessionMessage.Assistant` wire object. */
  toAssistantMessage(finish = 'stop', error = undefined, completed = Date.now()) {
    return {
      id: this.assistantMessageID,
      type: 'assistant',
      time: { created: this.created, completed },
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: this.modelID,
        ...(this.variant ? { variant: this.variant } : {}),
      },
      finish,
      ...(error ? { error } : {}),
      cost: 0,
      tokens: this.tokens,
      content: this.content,
    };
  }

  /**
   * Build a live snapshot of an in-progress `SessionMessage.Assistant` for `GET /message`
   * so refreshing or switching sessions mid-turn preserves active tools, thoughts, and text.
   */
  toInFlightAssistantMessage() {
    if (this.finished) return null;
    const content = [...this.content];
    if (this.openStream) {
      if (this.openStream.kind === 'text') {
        content.push({ type: 'text', text: this.openStream.buffer });
      } else {
        content.push({
          type: 'reasoning',
          text: this.openStream.buffer,
          time: { created: this.created },
        });
      }
    }
    for (const tool of this.activeTools.values()) {
      if (tool.closed) continue;
      content.push({
        type: 'tool',
        id: tool.callID,
        name: tool.name,
        executed: true,
        time: { created: tool.startedAt, ran: tool.startedAt },
        state: {
          status: 'running',
          input: tool.input,
          ...(tool.isOpenChamberTool
            ? {
                metadata: {
                  openchamber: {
                    schemaVersion: 1,
                    ...(typeof tool.input?.action === 'string' ? { action: tool.input.action } : {}),
                  },
                },
              }
            : {}),
        },
      });
    }
    for (const sub of this.activeSubagents) {
      if (sub.closed) continue;
      content.push({
        type: 'tool',
        id: sub.callID,
        name: 'subagent',
        executed: true,
        time: { created: sub.startedAt, ran: sub.startedAt },
        state: {
          status: 'running',
          input: sub.input,
          ...(sub.childSessionID ? { metadata: { sessionID: sub.childSessionID } } : {}),
        },
      });
    }
    return {
      id: this.assistantMessageID,
      type: 'assistant',
      time: { created: this.created },
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: this.modelID,
        ...(this.variant ? { variant: this.variant } : {}),
      },
      cost: 0,
      tokens: this.tokens,
      content,
    };
  }
}
