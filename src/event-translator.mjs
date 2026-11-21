import { AGY_PROVIDER_ID } from './agy-models.mjs';
import { OPENCHAMBER_TOOL_NAMES, normalizeOpenChamberToolName } from './mcp-bridge.mjs';

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
    /** @type {any[]} */
    this.content = [];
    this.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
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
    this._mergeUsage(step.usage);

    const stepIndex = Number.isInteger(step.step_index) ? step.step_index : -1;
    const stepType = step.step_type;

    if (stepType === 'user_input') return;

    const reasoningDelta = step.thinking_delta ?? step.thought_delta ?? step.reasoning_delta;
    if (stepType === 'thinking' || stepType === 'reasoning' || typeof reasoningDelta === 'string') {
      this._handleStreamDelta(stepIndex, 'reasoning', String(reasoningDelta ?? ''), step.state === 'DONE');
      return;
    }

    if (stepType === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      this._handleStreamDelta(stepIndex, 'text', delta, step.state === 'DONE');
      return;
    }

    if (stepType === 'tool') {
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
    const name = normalizeOpenChamberToolName(rawName);
    const isOpenChamberTool = OPENCHAMBER_TOOL_NAMES.has(name);
    const parameters = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
    let tool = this.activeTools.get(stepIndex);

    if (!tool) {
      const callID = String(info.call_id || info.id || `call_${this.assistantMessageID}_${stepIndex}`);
      tool = { callID, name, input: parameters, startedAt: Date.now(), closed: false };
      this.activeTools.set(stepIndex, tool);
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

    if (step.state === 'DONE' && !tool.closed) {
      tool.closed = true;
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

  /** @param {any} usage */
  _mergeUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    if (typeof usage.input_tokens === 'number') this.tokens.input = Math.max(this.tokens.input, usage.input_tokens);
    if (typeof usage.output_tokens === 'number') this.tokens.output = Math.max(this.tokens.output, usage.output_tokens);
    if (typeof usage.thinking_tokens === 'number') this.tokens.reasoning = Math.max(this.tokens.reasoning, usage.thinking_tokens);
    if (typeof usage.cache_read_tokens === 'number') this.tokens.cache.read = Math.max(this.tokens.cache.read, usage.cache_read_tokens);
  }

  /** @param {any} result */
  _handleResult(result) {
    if (result.conversation_id && this.onConversationId) {
      this.onConversationId(String(result.conversation_id));
    }
    this._mergeUsage(result.usage);

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

  /** Mark turn completed successfully and emit terminal OpenCode events. */
  complete() {
    if (this.finished) return;
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
      tokens: this.tokens,
    });
    this._send('session.execution.succeeded', { sessionID: this.sessionID });
    this._send('session.idle', { sessionID: this.sessionID });

    return this.toAssistantMessage('stop', undefined, completed);
  }

  /** @param {string} reason */
  interrupt(reason = 'user') {
    if (this.finished) return;
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
