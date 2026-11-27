import { AGY_PROVIDER_ID } from './models.mjs';
import {
  buildAcpToolResult,
  extractOpenChamberToolPayload,
  mergeAcpToolSnapshot,
  normalizeAcpToolInvocation,
  unwrapToolParamValue,
} from './tool-adapter.mjs';

const TRANSIENT_AUTH_ERROR_RE =
  /UNAUTHENTICATED\s*\(\s*code\s*401\s*\)|transport error\s*\(\s*Unauthenticated,\s*HTTP\s*401\s*\)|Request had invalid authentication credentials\.\s*Expected OAuth 2 access token/i;

const WARNING_PREFIX_HOLD_CHARS = 180;

/**
 * Detect transient OAuth 401 errors emitted by `agy acp` across the 1-hour token refresh boundary.
 * @param {string} text
 */
export function isTransientAgyAuthErrorText(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return TRANSIENT_AUTH_ERROR_RE.test(text);
}

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
   *   onStepSettled?: (msg: any) => void,
   *   onOpenChamberToolStart?: (info: { tool: string, callID: string }) => void,
   *   onSyncSubagents?: () => void,
   *   onSubagentWake?: (info: { recipientId: string }) => void,
   *   onSubagentKilled?: (info: { all: boolean, conversationIds: string[] }) => void,
   *   priorSessionTokens?: { input: number, output: number, reasoning: number, cache: { read: number, write: number } } | null,
   *   minCreated?: number,
   * }} options
   */
  constructor(options) {
    this.sessionID = options.sessionID;
    this.baseAssistantMessageID = options.assistantMessageID;
    this.modelID = options.modelID;
    this.variant = options.variant;
    this.agent = options.agent || 'agy-cli';
    this.directory = options.directory || null;
    this.toolContract = options.toolContract || null;
    this.emit = options.emit;
    this.onStepSettled = options.onStepSettled;
    this.onOpenChamberToolStart = options.onOpenChamberToolStart;
    this.onSyncSubagents = options.onSyncSubagents;
    this.onSubagentWake = options.onSubagentWake;
    this.onSubagentKilled = options.onSubagentKilled;
    this.priorSessionTokens = options.priorSessionTokens || emptyTokenBuckets();

    this.created = Math.max(Date.now(), typeof options.minCreated === 'number' ? options.minCreated : 0);
    this.started = false;
    this.finished = false;

    /** @type {{ kind: 'text'|'reasoning', ordinal: number, buffer: string, startedAt: number, step: any } | null} */
    this.openStream = null;
    /** @type {Map<string, { callID: string, name: string, rawName: string, input: any, inputJson: string, snapshot: any, normalized: any, startedAt: number, closed: boolean, isOpenChamberTool: boolean, step: any }>} */
    this.activeTools = new Map();
    /** @type {Array<{ callID: string, input: any, childSessionID: string | null, startedAt: number, notified: boolean, acpClosed: boolean, closed: boolean, step: any }>} */
    this.activeSubagents = [];

    this.latestWindowUsed = 0;
    this.tokens = emptyTokenBuckets();
    this.sessionTokens = addTokenBuckets(this.priorSessionTokens, emptyTokenBuckets());
    this.pendingWarningBuffer = null;
    this.authErrorDetected = false;
    this.authErrorMessage = '';
    /** @type {any[]} */
    this.steps = [];
    this.currentStep = this._createStep(1, this.created);
    this.steps.push(this.currentStep);
  }

  get assistantMessageID() {
    return this.currentStep.id;
  }

  get content() {
    return this.currentStep.content;
  }

  hasAnyContent() {
    return this.steps.some((step) => step.content.length > 0) || Boolean(this.openStream);
  }

  /**
   * Whether real progress (settled steps, tools, reasoning, or non-error text) has already occurred in this turn.
   */
  hasNonErrorProgress() {
    return (
      this.steps.length > 1
      || this.currentStep.hasTools
      || this.currentStep.content.length > 0
      || Boolean(this.openStream)
    );
  }

  /**
   * Reset transient auth-error state before retrying the turn on a freshly spawned ACP worker.
   * Preserves any prior completed tool/prose steps; opens a fresh step only if the current step already has content.
   */
  prepareForAuthRetry() {
    this.pendingWarningBuffer = null;
    this.authErrorDetected = false;
    this.authErrorMessage = '';
    this.priorSessionTokens = this.sessionTokens;
    this.tokens = emptyTokenBuckets();
    this.latestWindowUsed = 0;

    if (this.openStream) {
      this._closeOpenStream();
    }

    if (this.currentStep.content.length > 0 || this.currentStep.hasTools) {
      const prevStep = this.currentStep;
      const settledAt = Math.max(Date.now(), prevStep.created + 1);
      prevStep.closed = true;
      prevStep.completed = settledAt;
      prevStep.finish = prevStep.hasTools ? 'tool-calls' : 'unknown';
      prevStep.tokens = emptyTokenBuckets();
      prevStep.record = this._buildStepRecord(prevStep);
      this._send('session.step.ended', {
        sessionID: this.sessionID,
        assistantMessageID: prevStep.id,
        finish: prevStep.finish,
        cost: 0,
        tokens: prevStep.tokens,
      });
      if (this.onStepSettled) {
        this.onStepSettled(prevStep.record);
      }

      const nextStep = this._createStep(this.steps.length + 1, Math.max(Date.now(), settledAt + 1));
      this.steps.push(nextStep);
      this.currentStep = nextStep;
      this._emitStepStarted(nextStep);
    }
  }

  _createStep(index, created) {
    const suffix = index === 1 ? '' : `_s${String(index).padStart(2, '0')}`;
    return {
      index,
      id: `${this.baseAssistantMessageID}${suffix}`,
      created,
      firstTokenSent: false,
      textOrdinal: 0,
      reasoningOrdinal: 0,
      hasTools: false,
      openToolCount: 0,
      content: [],
      closed: false,
      completed: undefined,
      finish: undefined,
      error: undefined,
      tokens: emptyTokenBuckets(),
      record: null,
    };
  }

  _buildStepRecord(step, finishOverride = step.finish, errorOverride = step.error, completedOverride = step.completed) {
    const finish = finishOverride || 'stop';
    const completed = completedOverride ?? step.completed ?? Date.now();
    return {
      id: step.id,
      type: 'assistant',
      time: { created: step.created, completed },
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: this.modelID,
        ...(this.variant ? { variant: this.variant } : {}),
      },
      finish,
      ...(errorOverride ? { error: errorOverride } : {}),
      cost: 0,
      tokens: step.tokens,
      content: step.content,
    };
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

  _emitStepStarted(step) {
    this._send('session.step.started', {
      sessionID: this.sessionID,
      assistantMessageID: step.id,
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: this.modelID,
        ...(this.variant ? { variant: this.variant } : {}),
      },
    });
  }

  /**
   * Close the current tool-bearing step with `finish: 'tool-calls'` and open a fresh step
   * when new LLM output arrives after all tools in the current step have completed.
   */
  _maybeAdvanceStep() {
    if (this.finished) return;
    if (!this.currentStep.hasTools || this.currentStep.openToolCount > 0) return;

    this._closeOpenStream();

    const prevStep = this.currentStep;
    const settledAt = Math.max(Date.now(), prevStep.created + 1);
    prevStep.closed = true;
    prevStep.completed = settledAt;
    prevStep.finish = 'tool-calls';
    prevStep.tokens = emptyTokenBuckets();
    prevStep.record = this._buildStepRecord(prevStep);

    this._send('session.step.ended', {
      sessionID: this.sessionID,
      assistantMessageID: prevStep.id,
      finish: 'tool-calls',
      cost: 0,
      tokens: prevStep.tokens,
    });
    if (this.onStepSettled) {
      this.onStepSettled(prevStep.record);
    }

    const nextStep = this._createStep(this.steps.length + 1, Math.max(Date.now(), settledAt + 1));
    this.steps.push(nextStep);
    this.currentStep = nextStep;
    this._emitStepStarted(nextStep);
  }

  /** Start the turn and emit execution + step started events. */
  begin() {
    if (this.started) return;
    this.started = true;
    this._send('session.execution.started', { sessionID: this.sessionID });
    this._emitStepStarted(this.currentStep);
  }

  _closeOpenStream() {
    const stream = this.openStream;
    if (!stream) return;
    this.openStream = null;
    const step = stream.step;
    this._send(stream.kind === 'text' ? 'session.text.ended' : 'session.reasoning.ended', {
      sessionID: this.sessionID,
      assistantMessageID: step.id,
      ordinal: stream.ordinal,
      text: stream.buffer,
    });
    if (stream.kind === 'text') {
      step.content.push({ type: 'text', text: stream.buffer });
    } else {
      step.content.push({
        type: 'reasoning',
        text: stream.buffer,
        time: { created: stream.startedAt, completed: Date.now() },
      });
    }
  }

  _emitStreamDeltaDirect(kind, delta) {
    if (typeof delta !== 'string' || delta.length === 0) return;

    this._maybeAdvanceStep();

    const step = this.currentStep;
    if (!step.firstTokenSent) {
      step.firstTokenSent = true;
      this._send('session.step.first-token', {
        sessionID: this.sessionID,
        assistantMessageID: step.id,
      });
    }

    if (this.openStream && this.openStream.kind !== kind) {
      this._closeOpenStream();
    }

    if (!this.openStream) {
      const ordinal = kind === 'text' ? step.textOrdinal++ : step.reasoningOrdinal++;
      this.openStream = { kind, ordinal, buffer: '', startedAt: Date.now(), step };
      this._send(kind === 'text' ? 'session.text.started' : 'session.reasoning.started', {
        sessionID: this.sessionID,
        assistantMessageID: step.id,
        ordinal,
      });
    }

    this.openStream.buffer += delta;
    this._send(kind === 'text' ? 'session.text.delta' : 'session.reasoning.delta', {
      sessionID: this.sessionID,
      assistantMessageID: step.id,
      ordinal: this.openStream.ordinal,
      delta,
    });
  }

  flushPendingWarning() {
    if (this.pendingWarningBuffer === null) return;
    const buffered = this.pendingWarningBuffer;
    this.pendingWarningBuffer = null;
    this._emitStreamDeltaDirect('text', buffered);
  }

  /**
   * Append streaming text or reasoning delta from ACP chunk notifications.
   * Holds a short `'⚠'` text prefix so transient `UNAUTHENTICATED (code 401)` chunks
   * can be intercepted and retried before reaching SSE.
   * @param {'text'|'reasoning'} kind
   * @param {string} delta
   */
  _appendStreamDelta(kind, delta) {
    if (typeof delta !== 'string' || delta.length === 0) return;

    if (kind === 'text') {
      if (this.authErrorDetected) {
        this.authErrorMessage += delta;
        return;
      }
      if (this.pendingWarningBuffer !== null) {
        this.pendingWarningBuffer += delta;
        if (isTransientAgyAuthErrorText(this.pendingWarningBuffer)) {
          this.authErrorDetected = true;
          this.authErrorMessage = this.pendingWarningBuffer;
          this.pendingWarningBuffer = null;
          return;
        }
        if (
          this.pendingWarningBuffer.length >= WARNING_PREFIX_HOLD_CHARS
          || !this.pendingWarningBuffer.trimStart().startsWith('⚠')
        ) {
          this.flushPendingWarning();
        }
        return;
      }
      if (!this.openStream && delta.trimStart().startsWith('⚠')) {
        if (isTransientAgyAuthErrorText(delta)) {
          this.authErrorDetected = true;
          this.authErrorMessage = delta;
          return;
        }
        if (delta.length < WARNING_PREFIX_HOLD_CHARS) {
          this.pendingWarningBuffer = delta;
          return;
        }
      }
    } else {
      this.flushPendingWarning();
    }

    this._emitStreamDeltaDirect(kind, delta);
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
    this.flushPendingWarning();
    this._closeOpenStream();

    const step = this.currentStep;
    const callID = String(update.toolCallId || `call_${step.id}_${this.activeTools.size}`);
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
            ...(typeof normalized.input?.action === 'string'
              ? { action: normalized.input.action }
              : typeof normalized.input?.parameters?.action === 'string'
                ? { action: normalized.input.parameters.action }
                : {}),
          },
        }
      : undefined;

    let tool = existingTool;
    if (!tool) {
      step.hasTools = true;
      step.openToolCount += 1;
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
        step,
      };
      this.activeTools.set(callID, tool);
      if (tool.isOpenChamberTool && this.onOpenChamberToolStart) {
        this.onOpenChamberToolStart({ tool: tool.name, callID });
      }
      this._send('session.tool.input.started', {
        sessionID: this.sessionID,
        assistantMessageID: tool.step.id,
        id: callID,
        name: tool.name,
      });
      this._send('session.tool.called', {
        sessionID: this.sessionID,
        assistantMessageID: tool.step.id,
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
      tool.isOpenChamberTool = normalized.isOpenChamberTool;
      if (nextInputJson !== tool.inputJson) {
        tool.input = normalized.input;
        tool.inputJson = nextInputJson;
        this._send('session.tool.called', {
          sessionID: this.sessionID,
          assistantMessageID: tool.step.id,
          id: callID,
          input: tool.input,
          executed: true,
          ...(openchamberStartMeta ? { metadata: openchamberStartMeta } : {}),
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
    tool.step.openToolCount = Math.max(0, tool.step.openToolCount - 1);
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
      const parsedOut = extractOpenChamberToolPayload(update, outputText);
      const ok = parsedOut?.schemaVersion === 1 ? Boolean(parsedOut.ok) : !errorMsg;
      const answer = parsedOut?.data?.answer && typeof parsedOut.data.answer === 'object' ? parsedOut.data.answer : undefined;
      const action =
        typeof parsedOut?.action === 'string'
          ? parsedOut.action
          : typeof tool.input?.action === 'string'
            ? tool.input.action
            : typeof tool.input?.parameters?.action === 'string'
              ? tool.input.parameters.action
              : undefined;
      const description =
        typeof parsedOut?.data?.title === 'string' && parsedOut.data.title.trim()
          ? parsedOut.data.title.trim()
          : typeof tool.input?.title === 'string' && tool.input.title.trim()
            ? tool.input.title.trim()
            : typeof tool.input?.parameters?.title === 'string' && tool.input.parameters.title.trim()
              ? tool.input.parameters.title.trim()
              : undefined;
      mergedMeta = {
        ...mergedMeta,
        openchamber: {
          schemaVersion: 1,
          ...(action ? { action } : {}),
          ...(description ? { description } : {}),
          ok,
          ...(answer ? { answer } : {}),
        },
      };
    }

    if (errorMsg) {
      this._send('session.tool.failed', {
        sessionID: this.sessionID,
        assistantMessageID: tool.step.id,
        id: tool.callID,
        error: { type: 'unknown', message: errorMsg },
        content: contentItems,
        executed: true,
        ...(mergedMeta ? { metadata: mergedMeta } : {}),
      });
      tool.step.content.push({
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
        assistantMessageID: tool.step.id,
        id: tool.callID,
        content: contentItems,
        executed: true,
        ...(mergedMeta ? { metadata: mergedMeta } : {}),
      });
      tool.step.content.push({
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
    this._syncSettledStepRecord(tool.step);
  }

  _syncSettledStepRecord(step) {
    if (!step?.closed || !step.record) return;
    step.record = this._buildStepRecord(step);
    if (this.onStepSettled) {
      this.onStepSettled(step.record);
    }
  }

  _handleSubagentToolEvent(callID, parameters, status) {
    let entry = this.activeSubagents.find((s) => s.callID === callID);
    if (!entry) {
      const step = this.currentStep;
      step.hasTools = true;
      step.openToolCount += 1;
      const modelOpt = unwrapToolParamValue(parameters.Model ?? parameters.model);
      const workspaceOpt = unwrapToolParamValue(parameters.Workspace ?? parameters.workspace);
      const input = {
        agent: String(unwrapToolParamValue(parameters.TypeName ?? parameters.type_name) || 'subagent'),
        description: String(
          unwrapToolParamValue(parameters.Role ?? parameters.role ?? parameters.TypeName ?? parameters.type_name) || 'Subagent',
        ),
        prompt: String(unwrapToolParamValue(parameters.Prompt ?? parameters.initial_prompt) || ''),
        ...(typeof modelOpt === 'string' && modelOpt.trim() ? { model: modelOpt.trim() } : {}),
        ...(typeof workspaceOpt === 'string' && workspaceOpt.trim() ? { workspace: workspaceOpt.trim() } : {}),
      };
      entry = {
        callID,
        input,
        childSessionID: null,
        startedAt: Date.now(),
        notified: false,
        acpClosed: false,
        closed: false,
        step,
      };
      this.activeSubagents.push(entry);

      this._send('session.tool.input.started', {
        sessionID: this.sessionID,
        assistantMessageID: step.id,
        id: callID,
        name: 'subagent',
      });
      this._send('session.tool.called', {
        sessionID: this.sessionID,
        assistantMessageID: step.id,
        id: callID,
        input,
        executed: true,
      });
    }

    if (status === 'completed' || status === 'failed' || status === 'error') {
      if (!entry.acpClosed) {
        entry.acpClosed = true;
        entry.step.openToolCount = Math.max(0, entry.step.openToolCount - 1);
      }
      if (this.onSyncSubagents) {
        this.onSyncSubagents();
      }
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
      assistantMessageID: entry.step.id,
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
    if (!entry.acpClosed) {
      entry.acpClosed = true;
      entry.step.openToolCount = Math.max(0, entry.step.openToolCount - 1);
    }
    const state = info.state || 'completed';
    const now = Date.now();
    const output = String(info.output || '');
    const contentItems = output ? [{ type: 'text', text: output }] : [];
    const metadata = { status: state, sessionID: childSessionID };

    if (state === 'error') {
      this._send('session.tool.failed', {
        sessionID: this.sessionID,
        assistantMessageID: entry.step.id,
        id: entry.callID,
        error: { type: 'unknown', message: output || 'Subagent failed' },
        content: contentItems,
        executed: true,
        metadata,
      });
      entry.step.content.push({
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
        assistantMessageID: entry.step.id,
        id: entry.callID,
        content: contentItems,
        executed: true,
        metadata,
      });
      entry.step.content.push({
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
    this._syncSettledStepRecord(entry.step);
    return true;
  }

  _flushOpenTools(errorMessage = 'Tool execution interrupted') {
    const now = Date.now();
    const errText = String(errorMessage || 'Tool execution interrupted');
    for (const tool of this.activeTools.values()) {
      if (tool.closed) continue;
      tool.closed = true;
      tool.step.openToolCount = Math.max(0, tool.step.openToolCount - 1);
      const errObj = { type: 'unknown', message: errText };
      const openchamberMeta = tool.isOpenChamberTool
        ? {
            openchamber: {
              schemaVersion: 1,
              ...(typeof tool.input?.action === 'string' ? { action: tool.input.action } : {}),
              ok: false,
            },
          }
        : undefined;
      this._send('session.tool.failed', {
        sessionID: this.sessionID,
        assistantMessageID: tool.step.id,
        id: tool.callID,
        error: errObj,
        content: [],
        executed: true,
        ...(openchamberMeta ? { metadata: openchamberMeta } : {}),
      });
      tool.step.content.push({
        type: 'tool',
        id: tool.callID,
        name: tool.name,
        executed: true,
        time: { created: tool.startedAt, ran: tool.startedAt, completed: now },
        state: {
          status: 'error',
          input: tool.input,
          error: errObj,
          content: [],
          ...(openchamberMeta ? { metadata: openchamberMeta } : {}),
        },
      });
      this._syncSettledStepRecord(tool.step);
    }
  }

  _flushOpenSubagents(interrupted = false) {
    const now = Date.now();
    for (const entry of this.activeSubagents) {
      if (entry.closed) continue;
      entry.closed = true;
      if (!entry.acpClosed) {
        entry.acpClosed = true;
        entry.step.openToolCount = Math.max(0, entry.step.openToolCount - 1);
      }
      if (entry.childSessionID && !interrupted) {
        const metadata = { status: 'running', sessionID: entry.childSessionID };
        const contentItems = [{ type: 'text', text: 'Subagent running in background.' }];
        this._send('session.tool.success', {
          sessionID: this.sessionID,
          assistantMessageID: entry.step.id,
          id: entry.callID,
          content: contentItems,
          executed: true,
          metadata,
        });
        entry.step.content.push({
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
          assistantMessageID: entry.step.id,
          id: entry.callID,
          error: { type: 'unknown', message: interrupted ? 'Subagent interrupted' : 'Subagent did not report a session ID' },
          content: [],
          executed: true,
          ...(metadata ? { metadata } : {}),
        });
        entry.step.content.push({
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
      this._syncSettledStepRecord(entry.step);
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

  _finalizeTerminalStep(finish, error = undefined) {
    const step = this.currentStep;
    const completed = Math.max(Date.now(), step.created);
    step.closed = true;
    step.completed = completed;
    step.finish = finish;
    if (error) step.error = error;
    step.tokens = this.tokens;
    step.record = this._buildStepRecord(step);
    return step;
  }

  /** Mark turn completed successfully and emit terminal OpenCode events. */
  complete() {
    if (this.finished) return;
    this.flushPendingWarning();
    if (this.authErrorDetected && this.authErrorMessage) {
      this._emitStreamDeltaDirect('text', this.authErrorMessage);
    }
    this._closeOpenStream();
    this._flushOpenSubagents(false);
    this.finished = true;
    const step = this._finalizeTerminalStep('stop');

    this._send('session.step.ended', {
      sessionID: this.sessionID,
      assistantMessageID: step.id,
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

    return step.record;
  }

  /**
   * @param {string} reason
   * @param {{ emitIdle?: boolean, toolMessage?: string }} [options]
   */
  interrupt(reason = 'user', options = {}) {
    if (this.finished) return;
    const emitIdle = options.emitIdle !== false;
    const toolMessage = options.toolMessage || (emitIdle ? 'Interrupted by user' : 'Interrupted by follow-up message');
    this.flushPendingWarning();
    this._closeOpenStream();
    this._flushOpenTools(toolMessage);
    this._flushOpenSubagents(true);
    this.finished = true;
    const step = this._finalizeTerminalStep('unknown');

    this._send('session.step.ended', {
      sessionID: this.sessionID,
      assistantMessageID: step.id,
      finish: 'unknown',
      cost: 0,
      tokens: this.tokens,
    });
    if (this.tokens.input > 0 || this.tokens.output > 0) {
      this._send('session.usage.updated', {
        sessionID: this.sessionID,
        cost: 0,
        tokens: this.sessionTokens,
      });
    }
    if (emitIdle) {
      this._send('session.execution.interrupted', { sessionID: this.sessionID, reason });
      this._send('session.idle', { sessionID: this.sessionID });
    }

    return step.record;
  }

  /** @param {string} message */
  fail(message) {
    if (this.finished) return;
    this.flushPendingWarning();
    const resolvedMessage =
      String(message || '').trim()
      || (this.authErrorDetected ? this.authErrorMessage.trim() : '')
      || 'agy-cli error';
    this._closeOpenStream();
    this._flushOpenTools(resolvedMessage);
    this._flushOpenSubagents(true);
    this.finished = true;
    const errObj = { type: 'unknown', message: resolvedMessage };
    const step = this._finalizeTerminalStep('error', errObj);

    this._send('session.step.failed', {
      sessionID: this.sessionID,
      assistantMessageID: step.id,
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

    return step.record;
  }

  /** Build the persisted `SessionMessage.Assistant` wire object for the final/active step. */
  toAssistantMessage(finish = undefined, error = undefined, completed = undefined) {
    if (this.currentStep.record && finish === undefined && error === undefined && completed === undefined) {
      return this.currentStep.record;
    }
    return this._buildStepRecord(
      this.currentStep,
      finish ?? this.currentStep.finish ?? 'stop',
      error ?? this.currentStep.error,
      completed ?? this.currentStep.completed,
    );
  }

  /** Return all completed step `SessionMessage.Assistant` records produced in this turn. */
  toAssistantMessages() {
    return this.steps.filter((step) => Boolean(step.record)).map((step) => step.record);
  }

  _buildRunningPartsForStep(step) {
    const content = [...step.content];
    if (this.openStream && this.openStream.step === step) {
      if (this.openStream.kind === 'text') {
        content.push({ type: 'text', text: this.openStream.buffer });
      } else {
        content.push({
          type: 'reasoning',
          text: this.openStream.buffer,
          time: { created: this.openStream.startedAt },
        });
      }
    }
    for (const tool of this.activeTools.values()) {
      if (tool.closed || tool.step !== step) continue;
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
      if (sub.closed || sub.step !== step) continue;
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
    return content;
  }

  /**
   * Build a live snapshot of the active in-progress `SessionMessage.Assistant` for `GET /message`
   * so refreshing or switching sessions mid-turn preserves active tools, thoughts, and text.
   */
  toInFlightAssistantMessage() {
    if (this.finished) return null;
    const step = this.currentStep;
    return {
      id: step.id,
      type: 'assistant',
      time: { created: step.created },
      agent: this.agent,
      model: {
        providerID: AGY_PROVIDER_ID,
        id: this.modelID,
        ...(this.variant ? { variant: this.variant } : {}),
      },
      cost: 0,
      tokens: this.tokens,
      content: this._buildRunningPartsForStep(step),
    };
  }

  /**
   * Build live snapshots of all step messages (completed prior steps + current in-flight step)
   * produced so far in the active turn for `GET /message`.
   */
  toInFlightAssistantMessages() {
    if (this.finished) return [];
    const out = [];
    for (const step of this.steps) {
      if (step === this.currentStep) {
        const current = this.toInFlightAssistantMessage();
        if (current) out.push(current);
      } else if (step.record) {
        out.push({
          ...step.record,
          content: this._buildRunningPartsForStep(step),
        });
      }
    }
    return out;
  }
}
