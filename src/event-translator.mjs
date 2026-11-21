import { AGY_PROVIDER_ID } from './agy-models.mjs';
import { unwrapOpenChamberToolCall } from './mcp-bridge.mjs';

export function computeStepWindowTotal(parsed) {
  if (!parsed || typeof parsed !== 'object') return 0;
  return parsed.windowTotal || 0;
}

export function normalizeUsageBuckets(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const input = num(usage.input_tokens ?? usage.input);
  const output = num(usage.output_tokens ?? usage.output);
  const reasoning = num(usage.thinking_tokens ?? usage.reasoning);
  const cacheRead = num(usage.cache_read_tokens ?? usage.cache?.read);
  const cacheWrite = num(usage.cache_write_tokens ?? usage.cache?.write);
  const hasAny =
    typeof usage.input_tokens === 'number' ||
    typeof usage.output_tokens === 'number' ||
    typeof usage.thinking_tokens === 'number' ||
    typeof usage.cache_read_tokens === 'number' ||
    typeof usage.cache_write_tokens === 'number' ||
    typeof usage.total_tokens === 'number' ||
    typeof usage.input === 'number' ||
    typeof usage.output === 'number' ||
    typeof usage.reasoning === 'number';
  if (!hasAny) return null;

  // agy Gemini `total_tokens` equals `input_tokens + output_tokens` (with `thinking_tokens`
  // already included inside `output_tokens`) and excludes `cache_read_tokens`. When `total_tokens`
  // is absent (e.g. unit mocks), sum all buckets like OpenChamber's `sumTokenBreakdown`.
  const reportedTotal = num(usage.total_tokens ?? usage.total);
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

function unwrapToolParamValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
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

function diffCumulativeUsage(current, prior) {
  if (!prior) {
    return {
      input: current.input,
      output: current.output,
      reasoning: current.reasoning,
      cache: { read: current.cache.read, write: current.cache.write },
    };
  }
  const resetDetected =
    current.input < prior.input ||
    current.output < prior.output ||
    current.cache.read < prior.cache.read;
  if (resetDetected) {
    return {
      input: current.input,
      output: current.output,
      reasoning: current.reasoning,
      cache: { read: current.cache.read, write: current.cache.write },
    };
  }
  return {
    input: Math.max(0, current.input - prior.input),
    output: Math.max(0, current.output - prior.output),
    reasoning: Math.max(0, current.reasoning - prior.reasoning),
    cache: {
      read: Math.max(0, current.cache.read - prior.cache.read),
      write: Math.max(0, current.cache.write - prior.cache.write),
    },
  };
}

/**
 * Translate `agy-cli` `--output-format stream-json` NDJSON events into
 * OpenCode 2.3.2 `OpenCodeEvent` SSE events and final `SessionMessage.Assistant` content.
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
   *   emit: (event: any) => void,
   *   onConversationId?: (conversationId: string) => void,
   *   priorSessionTokens?: { input: number, output: number, reasoning: number, cache: { read: number, write: number } } | null,
   *   priorResultUsage?: { input: number, output: number, reasoning: number, cache: { read: number, write: number } } | null,
   * }} options
   */
  constructor(options) {
    this.sessionID = options.sessionID;
    this.assistantMessageID = options.assistantMessageID;
    this.modelID = options.modelID;
    this.variant = options.variant;
    this.agent = options.agent || 'agy-cli';
    this.directory = options.directory || null;
    this.emit = options.emit;
    this.onConversationId = options.onConversationId;
    this.onOpenChamberToolStart = options.onOpenChamberToolStart;
    this.onSubagentDiscovered = options.onSubagentDiscovered;
    this.onSystemMessageWakeup = options.onSystemMessageWakeup;
    this.onSubagentWake = options.onSubagentWake;
    this.onSubagentKilled = options.onSubagentKilled;
    this.onSyncThinking = options.onSyncThinking;
    this.priorSessionTokens = options.priorSessionTokens || emptyTokenBuckets();
    this.priorResultUsage = options.priorResultUsage || null;

    this.created = Date.now();
    this.started = false;
    this.finished = false;
    this.firstTokenSent = false;
    this.textOrdinal = 0;
    this.reasoningOrdinal = 0;

    /** @type {Map<number, { kind: 'text'|'reasoning', ordinal: number, buffer: string }>} */
    this.activeTextSteps = new Map();
    /** @type {Map<number, { callID: string, name: string, input: any, startedAt: number, closed: boolean }>} */
    this.activeTools = new Map();
    /** @type {Map<string, { callID: string, input: any, childSessionID: string | null, startedAt: number, notified: boolean, closed: boolean }>} */
    this.activeSubagents = new Map();
    /** @type {Set<number>} */
    this.emittedReasoningSteps = new Set();
    /** @type {any[]} */
    this.content = [];
    /** @type {Map<string, { input: number, output: number, reasoning: number, cache: { read: number, write: number }, windowTotal: number }>} */
    this.stepUsages = new Map();
    /** @type {string | null} */
    this.lastStepUsageKey = null;
    this.syntheticStepUsageSeq = 0;
    this.rawResultUsage = null;
    this.tokens = emptyTokenBuckets();
    this.sessionTokens = addTokenBuckets(this.priorSessionTokens, emptyTokenBuckets());
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

  /**
   * Process one parsed JSON line from `agy -p --output-format stream-json`.
   * @param {any} payload
   */
  handleLine(payload) {
    if (!payload || typeof payload !== 'object') return;
    this.begin();

    if (payload.conversation_id && this.onConversationId) {
      this.onConversationId(String(payload.conversation_id));
    }

    if (payload.event === 'init') {
      const conv = payload.conversation_id || payload.init?.conversation_id;
      if (conv && this.onConversationId) this.onConversationId(String(conv));
      return;
    }

    if (payload.event === 'step_update' && payload.step_update) {
      this._handleStepUpdate(payload.step_update);
      return;
    }

    if (payload.event === 'result' && payload.result) {
      this._handleResult(payload.result);
    }
  }

  /** @param {any} step */
  _handleStepUpdate(step) {
    if (step.conversation_id && this.onConversationId) {
      this.onConversationId(String(step.conversation_id));
    }
    this._recordStepUsage(step.step_index, step.usage);

    const stepIndex = Number.isInteger(step.step_index) ? step.step_index : -1;
    const stepType = step.step_type;

    if (stepType === 'user_input') return;

    if (stepType === 'system_message') {
      if (this.onSystemMessageWakeup) this.onSystemMessageWakeup();
      return;
    }

    if (stepType === 'subagent') {
      if (this.onSyncThinking) this.onSyncThinking(stepIndex);
      this._handleSubagentStep(stepIndex, step);
      return;
    }

    const reasoningDelta = step.thinking_delta ?? step.thought_delta ?? step.reasoning_delta;
    if (stepType === 'thinking' || stepType === 'reasoning' || typeof reasoningDelta === 'string') {
      if (stepIndex >= 0) this.emittedReasoningSteps.add(stepIndex);
      this._handleStreamDelta(stepIndex, 'reasoning', String(reasoningDelta ?? ''), step.state === 'DONE');
      return;
    }

    if (stepType === 'agent_response') {
      if (step.state === 'DONE' && this.onSyncThinking) {
        this.onSyncThinking(stepIndex);
      }
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      this._handleStreamDelta(stepIndex, 'text', delta, step.state === 'DONE');
      return;
    }

    if (stepType === 'tool') {
      if (!this.activeTools.has(stepIndex) && this.onSyncThinking) {
        this.onSyncThinking(stepIndex);
      }
      this._handleToolStep(stepIndex, step);
    }
  }

  /**
   * @param {number} stepIndex
   * @param {'text'|'reasoning'} kind
   * @param {string} delta
   * @param {boolean} done
   */
  _handleStreamDelta(stepIndex, kind, delta, done) {
    let entry = this.activeTextSteps.get(stepIndex);

    if (delta.length > 0) {
      if (!this.firstTokenSent) {
        this.firstTokenSent = true;
        this._send('session.step.first-token', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
        });
      }

      if (!entry) {
        const ordinal = kind === 'text' ? this.textOrdinal++ : this.reasoningOrdinal++;
        entry = { kind, ordinal, buffer: '' };
        this.activeTextSteps.set(stepIndex, entry);
        this._send(kind === 'text' ? 'session.text.started' : 'session.reasoning.started', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
          ordinal,
        });
      }

      entry.buffer += delta;
      this._send(kind === 'text' ? 'session.text.delta' : 'session.reasoning.delta', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        ordinal: entry.ordinal,
        delta,
      });
    }

    if (done && entry) {
      this._closeTextStep(stepIndex, entry);
    }
  }

  _closeTextStep(stepIndex, entry) {
    this.activeTextSteps.delete(stepIndex);
    this._send(entry.kind === 'text' ? 'session.text.ended' : 'session.reasoning.ended', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      ordinal: entry.ordinal,
      text: entry.buffer,
    });
    if (entry.kind === 'text') {
      this.content.push({ type: 'text', text: entry.buffer });
    } else {
      this.content.push({
        type: 'reasoning',
        text: entry.buffer,
        time: { created: this.created, completed: Date.now() },
      });
    }
  }

  _handleToolStep(stepIndex, step) {
    const info = step.tool_info || {};
    const rawName = String(step.tool_name || info.name || 'tool');
    const rawParams = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
    const unwrapped = unwrapOpenChamberToolCall(rawName, rawParams);
    const name = unwrapped.name;
    const isOpenChamberTool = unwrapped.isOpenChamberTool;
    const parameters = unwrapped.input;
    let tool = this.activeTools.get(stepIndex);

    if (!tool) {
      const callID = String(info.call_id || info.id || `call_${this.assistantMessageID}_${stepIndex}`);
      tool = { callID, name, input: parameters, startedAt: Date.now(), closed: false };
      this.activeTools.set(stepIndex, tool);
      if (isOpenChamberTool && this.onOpenChamberToolStart) {
        this.onOpenChamberToolStart({ tool: name, callID });
      }
      this._send('session.tool.input.started', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: callID,
        name,
      });
      this._send('session.tool.called', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
        id: callID,
        input: parameters,
        executed: true,
        ...(isOpenChamberTool
          ? {
              metadata: {
                openchamber: {
                  schemaVersion: 1,
                  ...(typeof parameters.action === 'string' ? { action: parameters.action } : {}),
                },
              },
            }
          : {}),
      });
    }

    if (name === 'send_message' && this.onSubagentWake) {
      const recipientId = unwrapToolParamValue(parameters.Recipient ?? parameters.recipient);
      if (typeof recipientId === 'string' && recipientId.trim()) {
        this.onSubagentWake({ recipientId: recipientId.trim() });
      }
    }

    if (step.state === 'DONE' && !tool.closed) {
      tool.closed = true;
      if (name === 'manage_subagents' && this.onSubagentKilled) {
        const action = String(unwrapToolParamValue(parameters.Action ?? parameters.action) || '').trim();
        if (action === 'kill_all') {
          this.onSubagentKilled({ all: true, conversationIds: [] });
        } else if (action === 'kill') {
          const rawIds = unwrapToolParamValue(parameters.ConversationIds ?? parameters.conversationIds);
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
      const output = typeof info.output === 'string'
        ? info.output
        : info.output != null
          ? JSON.stringify(info.output, null, 2)
          : '';
      const errorMsg = typeof info.error === 'string' ? info.error : info.error?.message;
      const contentItems = output ? [{ type: 'text', text: output }] : [];

      let openchamberMeta;
      if (isOpenChamberTool) {
        let parsedOut = null;
        try {
          parsedOut = output ? JSON.parse(output) : null;
        } catch {}
        const ok = parsedOut?.schemaVersion === 1 ? Boolean(parsedOut.ok) : !errorMsg;
        const answer = parsedOut?.data?.answer && typeof parsedOut.data.answer === 'object' ? parsedOut.data.answer : undefined;
        openchamberMeta = {
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
          ...(openchamberMeta ? { metadata: openchamberMeta } : {}),
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
            ...(openchamberMeta ? { metadata: openchamberMeta } : {}),
          },
        });
      } else {
        this._send('session.tool.success', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
          id: tool.callID,
          content: contentItems,
          executed: true,
          ...(openchamberMeta ? { metadata: openchamberMeta } : {}),
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
            ...(openchamberMeta ? { metadata: openchamberMeta } : {}),
          },
        });
      }
    }
  }

  /**
   * Record per-LLM-step usage snapshot keyed by `step_index` so multiple updates
   * to the same step overwrite rather than accumulate.
   * @param {number | undefined} stepIndex
   * @param {any} usage
   */
  _recordStepUsage(stepIndex, usage) {
    const parsed = normalizeUsageBuckets(usage);
    if (!parsed) return;
    const key = Number.isInteger(stepIndex) && stepIndex >= 0
      ? String(stepIndex)
      : `anon_${++this.syntheticStepUsageSeq}`;
    this.stepUsages.set(key, parsed);
    this.lastStepUsageKey = key;
    this._recomputeTokens();
  }

  /**
   * Record turn-end `result.usage` (which `agy` accumulates across the entire
   * conversation) without letting it overwrite per-step context snapshots.
   * @param {any} usage
   */
  _recordResultUsage(usage) {
    const parsed = normalizeUsageBuckets(usage);
    if (!parsed) return;
    this.rawResultUsage = parsed;
    this._recomputeTokens();
  }

  _recomputeTokens() {
    if (this.stepUsages.size > 0) {
      let turnBuckets = emptyTokenBuckets();
      for (const stepUsage of this.stepUsages.values()) {
        turnBuckets = addTokenBuckets(turnBuckets, stepUsage);
      }
      const lastStep = this.lastStepUsageKey ? this.stepUsages.get(this.lastStepUsageKey) : null;
      const windowTotal = lastStep?.windowTotal || 0;
      this.tokens = windowTotal > 0 ? { total: windowTotal, ...turnBuckets } : turnBuckets;
      this.sessionTokens = addTokenBuckets(this.priorSessionTokens, turnBuckets);
      return;
    }

    if (this.rawResultUsage) {
      const turnBuckets = diffCumulativeUsage(this.rawResultUsage, this.priorResultUsage);
      const windowTotal =
        turnBuckets.input +
        turnBuckets.output +
        turnBuckets.reasoning +
        turnBuckets.cache.read +
        turnBuckets.cache.write;
      this.tokens = windowTotal > 0 ? { total: windowTotal, ...turnBuckets } : turnBuckets;
      this.sessionTokens = addTokenBuckets(this.priorSessionTokens, turnBuckets);
    }
  }

  /**
   * Emit a completed reasoning block recovered from `transcript.jsonl` when `agy-cli` omits
   * thinking deltas from `--output-format stream-json`.
   * @param {number} stepIndex
   * @param {string} text
   */
  emitReasoning(stepIndex, text) {
    if (this.finished) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (Number.isInteger(stepIndex) && this.emittedReasoningSteps.has(stepIndex)) return;
    if (Number.isInteger(stepIndex)) this.emittedReasoningSteps.add(stepIndex);

    if (!this.firstTokenSent) {
      this.firstTokenSent = true;
      this._send('session.step.first-token', {
        sessionID: this.sessionID,
        assistantMessageID: this.assistantMessageID,
      });
    }

    const ordinal = this.reasoningOrdinal++;
    const now = Date.now();
    this._send('session.reasoning.started', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      ordinal,
    });
    this._send('session.reasoning.delta', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      ordinal,
      delta: trimmed,
    });
    this._send('session.reasoning.ended', {
      sessionID: this.sessionID,
      assistantMessageID: this.assistantMessageID,
      ordinal,
      text: trimmed,
    });
    this.content.push({
      type: 'reasoning',
      text: trimmed,
      time: { created: this.created, completed: now },
    });
  }

  /** @param {any} result */
  _handleResult(result) {
    if (result.conversation_id && this.onConversationId) {
      this.onConversationId(String(result.conversation_id));
    }
    if (this.onSyncThinking) {
      this.onSyncThinking(-1);
    }
    this._recordResultUsage(result.usage);

    // Flush any remaining open text steps
    for (const [idx, entry] of [...this.activeTextSteps.entries()]) {
      this._closeTextStep(idx, entry);
    }

    const hasTextContent = this.content.some((c) => c.type === 'text' && c.text.length > 0);
    if (!hasTextContent && typeof result.response === 'string' && result.response.length > 0) {
      this._handleStreamDelta(9999, 'text', result.response, true);
    }

    if (result.status && result.status !== 'SUCCESS') {
      const message = result.error || `agy-cli exited with status ${result.status}`;
      this.fail(message);
      return;
    }

    this.complete();
  }

  _handleSubagentStep(stepIndex, step) {
    const subs = Array.isArray(step.subagent_info?.subagents) && step.subagent_info.subagents.length > 0
      ? step.subagent_info.subagents
      : [{ type_name: step.tool_name || 'subagent', role: 'Subagent', initial_prompt: '' }];

    for (let k = 0; k < subs.length; k += 1) {
      const sub = subs[k] || {};
      const key = `${stepIndex}:${k}`;
      let entry = this.activeSubagents.get(key);

      if (!entry) {
        const callID = `call_${this.assistantMessageID}_sub_${stepIndex}_${k}`;
        const input = {
          agent: String(sub.type_name || 'subagent'),
          description: String(sub.role || sub.type_name || 'Subagent'),
          prompt: String(sub.initial_prompt || ''),
        };
        entry = {
          callID,
          input,
          childSessionID: null,
          startedAt: Date.now(),
          notified: false,
          closed: false,
        };
        this.activeSubagents.set(key, entry);

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

      if (step.state === 'DONE' && sub.conversation_id && !entry.notified) {
        const agyConversationId = String(sub.conversation_id);
        const childSessionID = agyConversationId.startsWith('agy_sub_')
          ? agyConversationId
          : `agy_sub_${agyConversationId}`;
        entry.notified = true;
        entry.childSessionID = childSessionID;

        this._send('session.tool.progress', {
          sessionID: this.sessionID,
          assistantMessageID: this.assistantMessageID,
          id: entry.callID,
          metadata: { sessionID: childSessionID },
        });

        if (this.onSubagentDiscovered) {
          this.onSubagentDiscovered({
            callID: entry.callID,
            childSessionID,
            agyConversationId,
            agent: entry.input.agent,
            title: entry.input.description,
            prompt: entry.input.prompt,
            logUri: sub.log_uri || null,
            workspaceUris: Array.isArray(sub.workspace_uris) ? sub.workspace_uris : [],
            startedAt: entry.startedAt,
          });
        }
      }
    }
  }

  /**
   * Complete an open `subagent` tool call inside this turn once the child finishes.
   * Returns `false` if this turn has already finished (caller should emit background synthetic completion).
   * @param {string} childSessionID
   * @param {{ state?: 'completed'|'error'|'cancelled', output?: string }} info
   */
  resolveSubagent(childSessionID, info = {}) {
    if (this.finished) return false;
    const entry = [...this.activeSubagents.values()].find((item) => item.childSessionID === childSessionID && !item.closed);
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
    for (const entry of this.activeSubagents.values()) {
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

  /** Mark turn completed successfully and emit terminal OpenCode events. */
  complete() {
    if (this.finished) return;
    this._flushOpenSubagents(false);
    this.finished = true;
    const completed = Date.now();

    for (const [idx, entry] of [...this.activeTextSteps.entries()]) {
      this._closeTextStep(idx, entry);
    }

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
    this._flushOpenSubagents(true);
    this.finished = true;
    const completed = Date.now();

    for (const [idx, entry] of [...this.activeTextSteps.entries()]) {
      this._closeTextStep(idx, entry);
    }

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
    this._flushOpenSubagents(true);
    this.finished = true;
    const completed = Date.now();
    const errObj = { type: 'unknown', message: String(message || 'agy-cli error') };

    for (const [idx, entry] of [...this.activeTextSteps.entries()]) {
      this._closeTextStep(idx, entry);
    }

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
}
