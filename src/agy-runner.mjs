import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveAgyBinary } from './config.mjs';
import { loadMagpieAgyEnv } from './magpie-env.mjs';
import { resolveRealAgyModelId } from './agy-models.mjs';
import { AgyTurnTranslator } from './event-translator.mjs';
import { buildSpawnSpec } from './upstream.mjs';
import { buildSessionGuidancePrefix } from './openchamber-bridge.mjs';
import { AGY_PROVIDER_ID } from './agy-models.mjs';
import {
  AgySubagentWatcher,
  buildSubagentCompletionSynthetic,
  fileUriToPath,
  isAgyChildSessionID,
  readTranscriptLines,
  resolveBrainTranscriptPath,
  resolveChildTranscriptPath,
  syncChildSessionFromTranscript,
  toChildSessionID,
} from './subagent-bridge.mjs';
import {
  buildAutoTitlePrompt,
  extractTitleCandidate,
  isUntitledSessionTitle,
  resolveTitleModelConfig,
} from './session-title.mjs';

const IS_WIN = process.platform === 'win32';
const DEFAULT_WORKER_IDLE_MS = 15 * 60_000;

/**
 * Manages persistent warm `agy-cli` workers (`--input-format stream-json`) per session
 * to eliminate per-turn cold-start latency (~8-10s) and preserve prompt prefix cache hits.
 */
export class AgyRunner {
  /**
   * @param {{
   *   store: import('./store.mjs').RouterStore,
   *   sseHub: import('./sse-hub.mjs').SseHub,
   *   env?: NodeJS.ProcessEnv,
   *   renameSessionTitle?: (params: { sessionID: string, title: string, directory?: string | null, signal?: AbortSignal }) => Promise<void>,
   * }} options
   */
  constructor(options) {
    this.store = options.store;
    this.sseHub = options.sseHub;
    this.env = options.env || process.env;
    this.renameSessionTitle = options.renameSessionTitle || null;
    const rawIdle = Number.parseInt(this.env.AGY_ROUTER_WORKER_IDLE_MS || '', 10);
    this.workerIdleMs = Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : DEFAULT_WORKER_IDLE_MS;
    this.useWarmWorker = this.env.AGY_ROUTER_WARM_WORKER !== '0';

    /**
     * @type {Map<string, {
     *   child: import('node:child_process').ChildProcess,
     *   realModelID: string,
     *   cwd: string,
     *   busy: boolean,
     *   exited: boolean,
     *   interrupted: boolean,
     *   idleTimer: NodeJS.Timeout | null,
     *   turn: { translator: AgyTurnTranslator, sessionID: string, modelID?: string, directory?: string | null, userText?: string } | null,
     * }>}
     */
    this.workers = new Map();
    /** @type {Map<string, { watcher: AgySubagentWatcher, parentSessionID: string }>} */
    this.childWatchers = new Map();
    /** @type {Map<string, Array<{ modelID: string, variant?: string, directory?: string | null, promptPayload: any }>>} */
    this.pendingTurnQueue = new Map();
    /** @type {Set<AbortController>} */
    this.autoTitleControllers = new Set();
    this.seq = 0;
  }

  /** @param {string} sessionID */
  isRunning(sessionID) {
    if (isAgyChildSessionID(sessionID)) {
      const entry = this.childWatchers.get(sessionID);
      return Boolean(entry && !entry.watcher.closed && entry.watcher.turnBusy);
    }
    return Boolean(this.workers.get(sessionID)?.busy);
  }

  activeSessionIds() {
    const ids = [];
    for (const [sid, w] of this.workers.entries()) {
      if (w.busy) ids.push(sid);
    }
    for (const [cid, entry] of this.childWatchers.entries()) {
      if (!entry.watcher.closed && entry.watcher.turnBusy) ids.push(cid);
    }
    return ids;
  }

  /**
   * Queue a follow-up turn payload when the session is currently busy (e.g. async `synthetic` delivery).
   * @param {string} sessionID
   * @param {{ modelID: string, variant?: string, directory?: string | null, promptPayload: any }} item
   */
  enqueueTurnInput(sessionID, item) {
    const list = this.pendingTurnQueue.get(sessionID) || [];
    list.push(item);
    this.pendingTurnQueue.set(sessionID, list);
  }

  /** @param {string} parentSessionID @param {{ cancelRemaining?: boolean, settleReplyNow?: boolean }} [options] */
  _flushSubagentWatchersForParent(parentSessionID, options = {}) {
    const cancelRemaining = Boolean(options.cancelRemaining);
    const settleReplyNow = Boolean(options.settleReplyNow);
    for (const [cid, entry] of [...this.childWatchers.entries()]) {
      if (entry.parentSessionID !== parentSessionID || entry.watcher.closed) continue;
      entry.watcher.flush({ settleReplyNow: !cancelRemaining && settleReplyNow });
      if (cancelRemaining) {
        entry.watcher.close('cancelled', 'Parent turn stopped');
        this.childWatchers.delete(cid);
      } else if (!entry.watcher.turnBusy) {
        entry.watcher.pausePolling();
      }
    }
  }

  /** @param {string} parentSessionID @param {string} recipientId */
  wakeSubagentWatcher(parentSessionID, recipientId) {
    const childSessionID = toChildSessionID(recipientId);
    if (!childSessionID) return;

    const existing = this.childWatchers.get(childSessionID);
    if (existing && !existing.watcher.closed) {
      existing.watcher.resume();
      return;
    }

    let rec = this.store.getChildSessionRecord(childSessionID);
    if (!rec) return;
    const transcriptPath = resolveChildTranscriptPath(rec);
    if (!transcriptPath) return;
    if (!rec.lastSyncedLineCount) {
      syncChildSessionFromTranscript({ childRecord: rec, store: this.store });
      rec = this.store.getChildSessionRecord(childSessionID) || rec;
    }

    const parentConversationId =
      rec.parentConversationId || this.store.getSession(parentSessionID)?.agyConversationId || '';
    const watcher = new AgySubagentWatcher({
      childSessionID,
      parentSessionID: rec.parentID || parentSessionID,
      parentConversationId,
      agent: rec.agent || 'subagent',
      title: rec.title || rec.agent || 'Subagent',
      modelID: rec.model?.id || 'agy-subagent',
      directory: rec.directory || null,
      transcriptPath,
      store: this.store,
      emit: (ev) => this.sseHub.broadcast(ev),
      initialSyncedLineCount: rec.lastSyncedLineCount ?? 0,
    });
    this.childWatchers.set(childSessionID, { watcher, parentSessionID: rec.parentID || parentSessionID });
    watcher.resume();
  }

  /** @param {string} parentSessionID @param {{ all: boolean, conversationIds: string[] }} killInfo */
  handleSubagentKill(parentSessionID, killInfo) {
    if (killInfo.all) {
      for (const [cid, entry] of [...this.childWatchers.entries()]) {
        if (entry.parentSessionID !== parentSessionID) continue;
        entry.watcher.close('completed');
        this.childWatchers.delete(cid);
      }
      return;
    }
    for (const convId of killInfo.conversationIds || []) {
      const childSessionID = toChildSessionID(convId);
      const entry = this.childWatchers.get(childSessionID);
      if (entry) {
        entry.watcher.close('completed');
        this.childWatchers.delete(childSessionID);
      } else {
        this.syncChildSession(childSessionID);
      }
    }
  }

  /** @param {string} childSessionID */
  syncChildSession(childSessionID) {
    if (!isAgyChildSessionID(childSessionID)) return false;
    const entry = this.childWatchers.get(childSessionID);
    if (entry && !entry.watcher.closed) {
      const parentBusy = this.isRunning(entry.parentSessionID);
      entry.watcher.flush({ settleReplyNow: !parentBusy });
      return true;
    }
    const rec = this.store.getChildSessionRecord(childSessionID);
    if (!rec) return false;
    return syncChildSessionFromTranscript({ childRecord: rec, store: this.store });
  }

  async _drainPendingQueue(sessionID) {
    const list = this.pendingTurnQueue.get(sessionID);
    if (!list || list.length === 0 || this.isRunning(sessionID)) return;
    const next = list.shift();
    if (list.length === 0) this.pendingTurnQueue.delete(sessionID);
    if (!next) return;
    await this.startTurn({
      sessionID,
      modelID: next.modelID,
      variant: next.variant,
      directory: next.directory,
      promptPayload: next.promptPayload,
    });
  }

  _handleSubagentDiscovered(parentSessionID, parentModelID, cwd, info) {
    const parentState = this.store.getSession(parentSessionID);
    const childDir = parentState?.directory || cwd;
    const projectID = parentState?.projectID || 'project_default';
    const childSessionID = info.childSessionID;
    const modelRef = { providerID: AGY_PROVIDER_ID, id: parentModelID };

    const transcriptPath = fileUriToPath(info.logUri);
    const parentConversationId = parentState?.agyConversationId || '';
    this.store.createChildSession({
      sessionID: childSessionID,
      parentID: parentSessionID,
      projectID,
      directory: childDir,
      title: info.title || info.agent || 'Subagent',
      agent: info.agent || 'subagent',
      model: modelRef,
      agyConversationId: info.agyConversationId,
      parentConversationId,
      transcriptPath,
      createdAt: info.startedAt,
    });

    const loc = childDir ? { location: { directory: childDir } } : {};
    this.sseHub.broadcast({
      type: 'session.created',
      created: info.startedAt,
      ...loc,
      data: {
        sessionID: childSessionID,
        parentID: parentSessionID,
        projectID,
        title: info.title || info.agent || 'Subagent',
        agent: info.agent || 'subagent',
        model: modelRef,
      },
    });
    this.sseHub.broadcast({
      type: 'session.execution.started',
      created: info.startedAt,
      ...loc,
      data: { sessionID: childSessionID },
    });

    const watcher = new AgySubagentWatcher({
      childSessionID,
      parentSessionID,
      parentConversationId,
      agent: info.agent || 'subagent',
      title: info.title || info.agent || 'Subagent',
      modelID: parentModelID,
      directory: childDir,
      transcriptPath,
      store: this.store,
      emit: (ev) => this.sseHub.broadcast(ev),
      onComplete: ({ childSessionID: cid, state, output }) => {
        const activeTranslator = this.workers.get(parentSessionID)?.turn?.translator;
        if (activeTranslator && activeTranslator.resolveSubagent(cid, { state, output })) {
          return;
        }
        const syn = buildSubagentCompletionSynthetic({
          childSessionID: cid,
          agent: info.agent,
          title: info.title,
          state,
          output,
        });
        this.store.upsertMessage(parentSessionID, syn);
        const now = Date.now();
        this.sseHub.broadcast({
          type: 'session.inbox.enqueued',
          created: now,
          ...loc,
          data: {
            sessionID: parentSessionID,
            inboxID: syn.id,
            item: {
              type: 'synthetic',
              payload: {
                text: syn.text,
                ...(syn.description ? { description: syn.description } : {}),
                metadata: syn.metadata,
              },
            },
          },
        });
        this.sseHub.broadcast({
          type: 'session.inbox.delivered',
          created: now,
          ...loc,
          data: { sessionID: parentSessionID, inboxID: syn.id },
        });
      },
    });

    this.childWatchers.set(childSessionID, { watcher, parentSessionID });
    watcher.start();
  }

  /**
   * Format prompt text including any file attachments, inline skills, non-resuming synthetic context,
   * and one-time OpenChamber UI guidance.
   * @param {{ text?: string, files?: any[], skills?: any[] }} payload
   * @param {{ syntheticTexts?: string[], guidancePrefix?: string | null }} [options]
   */
  buildPromptText(payload, options = {}) {
    const sections = [];
    if (options.guidancePrefix) {
      sections.push(options.guidancePrefix);
    }
    if (Array.isArray(options.syntheticTexts) && options.syntheticTexts.length > 0) {
      sections.push(options.syntheticTexts.join('\n\n'));
    }

    const skills = Array.isArray(payload?.skills) ? payload.skills : [];
    if (skills.length > 0) {
      const skillText = skills
        .map((s) => (s?.content ? `[Skill: ${s.name || s.id}]\n${s.content}` : `[Use skill: ${s?.name || s?.id || ''}]`))
        .filter(Boolean)
        .join('\n\n');
      if (skillText) sections.push(skillText);
    }

    const base = String(payload?.text || '').trim();
    if (base) sections.push(base);

    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (files.length > 0) {
      const hints = [];
      for (const file of files) {
        const label = file.name || file.mime || 'attachment';
        const uri = file.source?.type === 'uri' ? file.source.uri : null;
        if (uri) hints.push(`- ${label}: ${uri}`);
        else hints.push(`- ${label} (${file.mime || 'inline'})`);
      }
      sections.push(['[Attached files]', ...hints].join('\n'));
    }

    return sections.filter(Boolean).join('\n\n');
  }

  /**
   * Build child environment and base CLI flags for `agy-cli`.
   * @param {{ sessionID?: string, cwd?: string, realModelID?: string, conversationId?: string | null }} opts
   */
  _buildAgySpawnConfig(opts = {}) {
    const agyBin = resolveAgyBinary(this.env);
    if (!agyBin) return null;

    const useMagpie = this.env.AGY_ROUTER_USE_MAGPIE === '1';
    const childEnv = { ...this.env };
    if (opts.sessionID) childEnv.OPENCHAMBER_ROUTER_SESSION_ID = opts.sessionID;
    if (opts.cwd) childEnv.OPENCHAMBER_ROUTER_DIRECTORY = opts.cwd;
    if (opts.callLogPath) childEnv.OPENCHAMBER_ROUTER_CALL_LOG = opts.callLogPath;
    const args = [];

    if (useMagpie) {
      const magpie = loadMagpieAgyEnv({ env: this.env });
      Object.assign(childEnv, magpie.envPatch);
      if (magpie.settingsPath) args.push('--settings', magpie.settingsPath);
    } else {
      delete childEnv.GEMINI_API_KEY;
      delete childEnv.GOOGLE_GEMINI_BASE_URL;
    }

    return { agyBin, childEnv, args };
  }

  /**
   * Terminate a child process cleanly on Windows/POSIX.
   * @param {import('node:child_process').ChildProcess} child
   */
  _killChild(child) {
    try {
      if (IS_WIN && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // Ignore kill errors
    }
  }

  /**
   * @param {string} sessionID
   * @param {boolean} [forceKill]
   */
  _retireWorker(sessionID, forceKill = false) {
    const w = this.workers.get(sessionID);
    if (!w) return;
    if (w.idleTimer) {
      clearTimeout(w.idleTimer);
      w.idleTimer = null;
    }
    this.workers.delete(sessionID);
    if (w.exited) return;

    if (!forceKill) {
      try {
        if (w.child.stdin && !w.child.stdin.destroyed) {
          w.child.stdin.end();
        }
        return;
      } catch {
        // Fall through to hard kill
      }
    }

    this._killChild(w.child);
  }

  /**
   * Spawn a persistent warm worker (or single-shot worker if `AGY_ROUTER_WARM_WORKER=0`).
   * @param {{ sessionID: string, realModelID: string, cwd: string, promptText: string }} opts
   */
  _spawnWorker(opts) {
    const cfg = this._buildAgySpawnConfig({
      sessionID: opts.sessionID,
      cwd: opts.cwd,
      callLogPath: opts.callLogPath,
    });
    if (!cfg) return null;

    const sessionState = this.store.getSession(opts.sessionID);
    const args = [...cfg.args];

    if (this.useWarmWorker) {
      args.push('--input-format', 'stream-json');
    }
    args.push('--output-format', 'stream-json');
    if (opts.realModelID) {
      args.push('--model', opts.realModelID);
    }
    if (sessionState?.agyConversationId) {
      args.push('--conversation', sessionState.agyConversationId);
    }
    if (this.env.AGY_ROUTER_AGY_AUTO_APPROVE !== '0') {
      args.push('--dangerously-skip-permissions');
    }
    if (this.useWarmWorker) {
      args.push('--print=');
    } else {
      args.push('-p', opts.promptText);
    }

    const spec = buildSpawnSpec(cfg.agyBin, args);
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: cfg.childEnv,
      windowsHide: true,
      stdio: [this.useWarmWorker ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});

    const worker = {
      child,
      realModelID: opts.realModelID,
      cwd: opts.cwd,
      busy: false,
      exited: false,
      interrupted: false,
      hadFirstTurn: Boolean(sessionState?.agyConversationId),
      idleTimer: null,
      turn: null,
      stdoutBuf: '',
      stderrBuf: '',
    };

    const settleTurn = (outcome, message) => {
      const activeTurn = worker.turn;
      if (!activeTurn) return;
      const aborted = outcome === 'interrupt' || outcome === 'fail';
      this._flushSubagentWatchersForParent(activeTurn.sessionID, {
        cancelRemaining: aborted,
        settleReplyNow: !aborted,
      });
      worker.turn = null;
      worker.busy = false;

      let assistantMsg;
      if (outcome === 'interrupt') {
        assistantMsg = activeTurn.translator.interrupt('user');
      } else if (outcome === 'fail') {
        assistantMsg = activeTurn.translator.fail(message);
      } else if (!activeTurn.translator.finished) {
        assistantMsg = activeTurn.translator.complete();
      } else {
        assistantMsg = activeTurn.translator.toAssistantMessage('stop');
      }

      if (assistantMsg) {
        this.store.upsertMessage(activeTurn.sessionID, assistantMsg);
      }
      if (outcome === 'complete' && assistantMsg) {
        const assistantText = (assistantMsg.content || [])
          .filter((p) => p?.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
          .trim();
        this._maybeAutoNameSession({
          sessionID: activeTurn.sessionID,
          modelID: activeTurn.modelID,
          directory: activeTurn.directory,
          userText: activeTurn.userText || '',
          assistantText,
        });
      }
      if (activeTurn.translator.rawResultUsage || activeTurn.translator.stepUsages.size > 0) {
        this.store.recordTurnUsage(activeTurn.sessionID, {
          sessionTokens: activeTurn.translator.sessionTokens,
          lastResultUsage: activeTurn.translator.rawResultUsage
            ? {
                input: activeTurn.translator.rawResultUsage.input,
                output: activeTurn.translator.rawResultUsage.output,
                reasoning: activeTurn.translator.rawResultUsage.reasoning,
                cache: { ...activeTurn.translator.rawResultUsage.cache },
              }
            : undefined,
        });
      }

      if (this.useWarmWorker && !worker.exited && this.workerIdleMs > 0) {
        if (worker.idleTimer) clearTimeout(worker.idleTimer);
        worker.idleTimer = setTimeout(() => {
          if (!worker.busy) this._retireWorker(opts.sessionID, false);
        }, this.workerIdleMs);
        worker.idleTimer.unref();
      }

      queueMicrotask(() => {
        void this._drainPendingQueue(activeTurn.sessionID);
      });
    };

    const handleJsonLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (parsed?.conversation_id) {
        this.store.setAgyConversationId(opts.sessionID, String(parsed.conversation_id));
      }

      const activeTurn = worker.turn;
      if (!activeTurn) return;

      if (parsed?.event === 'result') {
        this._flushSubagentWatchersForParent(activeTurn.sessionID, { cancelRemaining: false, settleReplyNow: true });
      }

      activeTurn.translator.handleLine(parsed);
      if (parsed?.event === 'result') {
        if (parsed.result?.status && parsed.result.status !== 'SUCCESS') {
          settleTurn('fail', parsed.result.error || `agy-cli exited with status ${parsed.result.status}`);
        } else {
          settleTurn('complete');
        }
      }
    };

    child.stdout?.on('data', (chunk) => {
      worker.stdoutBuf += chunk.toString();
      const lines = worker.stdoutBuf.split(/\r?\n/);
      worker.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        handleJsonLine(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      worker.stderrBuf = (worker.stderrBuf + chunk.toString()).slice(-4096);
    });

    child.on('close', (code) => {
      worker.exited = true;
      if (worker.idleTimer) {
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
      }
      if (this.workers.get(opts.sessionID) === worker) {
        this.workers.delete(opts.sessionID);
      }
      if (worker.stdoutBuf.trim()) {
        handleJsonLine(worker.stdoutBuf);
        worker.stdoutBuf = '';
      }
      if (worker.turn) {
        if (worker.interrupted) {
          settleTurn('interrupt');
        } else if (code === 0) {
          settleTurn('complete');
        } else {
          settleTurn('fail', worker.stderrBuf.trim() || `agy-cli exited with code ${code}`);
        }
      }
    });

    child.on('error', (err) => {
      worker.exited = true;
      if (this.workers.get(opts.sessionID) === worker) {
        this.workers.delete(opts.sessionID);
      }
      settleTurn('fail', err?.message || String(err));
    });

    return worker;
  }

  /**
   * Start an `agy-cli` turn asynchronously, reusing the session's warm worker when compatible.
   * @param {{ sessionID: string, modelID: string, variant?: string, realModelID?: string, agent?: string, directory?: string | null, promptPayload: any }} params
   */
  async startTurn(params) {
    const { sessionID, modelID, variant, agent, directory, promptPayload } = params;
    const existing = this.workers.get(sessionID);
    if (existing?.busy) {
      return { ok: false, reason: 'busy' };
    }

    const sessionState = this.store.getSession(sessionID);
    const needsGuidance = !sessionState?.agyConversationId
      && !existing?.hadFirstTurn
      && this.env.AGY_ROUTER_DISABLE_UI_GUIDANCE !== '1';
    const guidancePrefix = needsGuidance
      ? await buildSessionGuidancePrefix({
          env: this.env,
          hasMcpBridge: Boolean(this.env.OPENCHAMBER_AGENT_TOOL_URL && this.env.OPENCHAMBER_AGENT_TOOL_TOKEN),
        })
      : null;

    const syntheticTexts = this.store.consumePendingSynthetic(sessionID);
    const realModelID = params.realModelID || resolveRealAgyModelId(modelID, variant, { env: this.env });
    const cwd = directory && fs.existsSync(directory) ? directory : process.cwd();
    const promptText = this.buildPromptText(promptPayload, { syntheticTexts, guidancePrefix });

    const safeSession = String(sessionID).replace(/[^a-zA-Z0-9._-]/g, '_');
    const callLogPath = path.join(this.store.sessionsDir, `${safeSession}.calls.jsonl`);
    const assistantMessageID = `msg_${Date.now()}_${++this.seq}`;
    const existingConvId = sessionState?.agyConversationId || null;
    const initialTranscriptPath = existingConvId
      ? resolveBrainTranscriptPath(existingConvId, this.env.AGY_ROUTER_HOME_DIR || undefined)
      : null;
    const startTranscriptLineOffset = initialTranscriptPath
      ? (readTranscriptLines(initialTranscriptPath)?.length ?? 0)
      : 0;

    const turnState = {
      translator: null,
      sessionID,
      modelID,
      directory,
      userText: String(promptPayload?.text || '').trim(),
      agyConversationId: existingConvId,
      transcriptLineOffset: startTranscriptLineOffset,
    };

    const translator = new AgyTurnTranslator({
      sessionID,
      assistantMessageID,
      modelID,
      variant,
      agent,
      directory,
      priorSessionTokens: sessionState?.sessionTokens || null,
      priorResultUsage: sessionState?.lastAgyResultUsage || null,
      emit: (ev) => this.sseHub.broadcast(ev),
      onConversationId: (convId) => {
        turnState.agyConversationId = convId;
        this.store.setAgyConversationId(sessionID, convId);
      },
      onSubagentDiscovered: (info) => this._handleSubagentDiscovered(sessionID, modelID, cwd, info),
      onSubagentWake: ({ recipientId }) => this.wakeSubagentWatcher(sessionID, recipientId),
      onSubagentKilled: (killInfo) => this.handleSubagentKill(sessionID, killInfo),
      onSystemMessageWakeup: () => this._flushSubagentWatchersForParent(sessionID, { cancelRemaining: false, settleReplyNow: false }),
      onSyncThinking: () => this._syncTurnThinking(turnState),
      onOpenChamberToolStart: ({ tool, callID }) => {
        try {
          fs.appendFileSync(callLogPath, `${JSON.stringify({ tool, callID, ts: Date.now() })}\n`, 'utf8');
        } catch {}
      },
    });
    turnState.translator = translator;

    const canReuse =
      this.useWarmWorker
      && existing
      && !existing.exited
      && !existing.busy
      && existing.realModelID === realModelID
      && existing.cwd === cwd;

    let worker = canReuse ? existing : null;
    if (!worker) {
      if (existing) this._retireWorker(sessionID, false);
      try {
        fs.unlinkSync(callLogPath);
      } catch {}
      worker = this._spawnWorker({ sessionID, realModelID, cwd, promptText, callLogPath });
      if (!worker) {
        translator.begin();
        const msg = translator.fail('agy executable not found on this machine');
        if (msg) this.store.upsertMessage(sessionID, msg);
        return { ok: true };
      }
      this.workers.set(sessionID, worker);
    }

    if (worker.idleTimer) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }

    worker.busy = true;
    worker.interrupted = false;
    worker.hadFirstTurn = true;
    worker.turn = turnState;
    translator.begin();

    if (this.useWarmWorker) {
      try {
        worker.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: promptText } })}\n`);
      } catch (err) {
        this._retireWorker(sessionID, true);
        const msg = translator.fail(err?.message || 'Failed to write prompt to agy-cli stdin');
        if (msg) this.store.upsertMessage(sessionID, msg);
      }
    }

    return { ok: true };
  }

  /**
   * Run a stateless one-shot text generation via `agy-cli` for `/api/experimental/generate/text`.
   * Sends prompt via stdin (`stream-json`) to avoid OS command-line length limits.
   * @param {{ prompt: string, modelID: string, variant?: string, directory?: string | null, timeoutMs?: number, signal?: AbortSignal }} params
   * @returns {Promise<string>}
   */
  generateText(params) {
    const cwd = params.directory && fs.existsSync(params.directory) ? params.directory : process.cwd();
    const cfg = this._buildAgySpawnConfig({ cwd });
    if (!cfg) {
      return Promise.reject(new Error('agy executable not found on this machine'));
    }

    const realModelID = resolveRealAgyModelId(params.modelID, params.variant, { env: this.env });
    const args = [...cfg.args, '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (realModelID) args.push('--model', realModelID);
    if (this.env.AGY_ROUTER_AGY_AUTO_APPROVE !== '0') {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--print=');

    const spec = buildSpawnSpec(cfg.agyBin, args);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: cfg.childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let deltaText = '';
      let resultText = '';
      let timer = null;

      const finish = (err, text) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (params.signal) params.signal.removeEventListener('abort', onAbort);
        try {
          if (child.stdin && !child.stdin.destroyed) child.stdin.end();
        } catch {}
        if (err) {
          this._killChild(child);
          reject(err);
        } else {
          resolve(text ?? '');
        }
      };

      const onAbort = () => {
        finish(new Error('agy-cli text generation aborted'));
      };
      if (params.signal) {
        if (params.signal.aborted) {
          onAbort();
          return;
        }
        params.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : 55_000;
      timer = setTimeout(() => {
        finish(new Error(`agy-cli text generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const processLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (parsed?.event === 'step_update' && parsed.step_update?.step_type === 'agent_response') {
          if (typeof parsed.step_update.text_delta === 'string') {
            deltaText += parsed.step_update.text_delta;
          }
        } else if (parsed?.event === 'result' && parsed.result) {
          if (typeof parsed.result.response === 'string') {
            resultText = parsed.result.response;
          }
          if (parsed.result.status && parsed.result.status !== 'SUCCESS') {
            finish(new Error(parsed.result.error || `agy-cli exited with status ${parsed.result.status}`));
            return;
          }
          finish(null, resultText || deltaText);
        }
      };

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString()).slice(-4096);
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) {
          processLine(stdoutBuf);
          stdoutBuf = '';
        }
        if (settled) return;
        if (code === 0 && (resultText || deltaText)) {
          finish(null, resultText || deltaText);
        } else {
          finish(new Error(stderrBuf.trim() || `agy-cli exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });

      try {
        child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: String(params.prompt || '') } })}\n`);
      } catch (err) {
        finish(err instanceof Error ? err : new Error('Failed to write prompt to agy-cli stdin'));
      }
    });
  }

  /** @param {string} sessionID */
  closeWatchersForParent(sessionID) {
    for (const [cid, entry] of [...this.childWatchers.entries()]) {
      if (entry.parentSessionID === sessionID) {
        entry.watcher.close('cancelled', 'Parent session deleted');
        this.childWatchers.delete(cid);
      }
    }
  }

  /**
   * Interrupt an active `agy-cli` turn for `sessionID`.
   * @param {string} sessionID
   */
  interrupt(sessionID) {
    if (isAgyChildSessionID(sessionID)) {
      const entry = this.childWatchers.get(sessionID);
      if (!entry || entry.watcher.closed || !entry.watcher.turnBusy) return false;
      entry.watcher.close('cancelled', 'Stopped by user');
      this.childWatchers.delete(sessionID);
      return true;
    }
    const worker = this.workers.get(sessionID);
    if (!worker || !worker.busy) return false;
    worker.interrupted = true;
    this._retireWorker(sessionID, true);
    return true;
  }

  /**
   * Recover model thinking blocks from `transcript.jsonl` when `agy-cli` omits thinking deltas
   * from `--output-format stream-json`.
   * @param {{ translator: AgyTurnTranslator, agyConversationId: string | null, transcriptLineOffset: number }} turnState
   */
  _syncTurnThinking(turnState) {
    if (!turnState?.agyConversationId || turnState.translator?.finished) return;
    const tpath = resolveBrainTranscriptPath(turnState.agyConversationId, this.env.AGY_ROUTER_HOME_DIR || undefined);
    if (!tpath) return;
    const lines = readTranscriptLines(tpath);
    if (!lines || lines.length <= turnState.transcriptLineOffset) return;

    for (let i = turnState.transcriptLineOffset; i < lines.length; i += 1) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry?.type === 'PLANNER_RESPONSE' && typeof entry.thinking === 'string' && entry.thinking.trim()) {
          turnState.translator.emitReasoning(entry.step_index, entry.thinking);
        }
      } catch {
        // Ignore partial line while writer flushes
      }
    }
    turnState.transcriptLineOffset = lines.length;
  }

  /**
   * Generate and persist a short session title after the first completed `agy-cli` turn.
   * @param {{ sessionID: string, modelID?: string, directory?: string | null, userText: string, assistantText: string }} params
   */
  _maybeAutoNameSession(params) {
    if (this.env.AGY_ROUTER_DISABLE_AUTO_TITLE === '1' || !this.renameSessionTitle) return;
    const { sessionID, userText, assistantText } = params;
    if (!userText.trim() || !assistantText.trim()) return;
    if (!this.store.needsAutoTitle(sessionID)) return;

    this.store.markAutoTitleState(sessionID, 'pending');
    const controller = new AbortController();
    this.autoTitleControllers.add(controller);

    void (async () => {
      try {
        const titleCfg = resolveTitleModelConfig({ sessionModelID: params.modelID, env: this.env });
        const raw = await this.generateText({
          prompt: buildAutoTitlePrompt({ userText, assistantText }),
          modelID: titleCfg.modelID,
          variant: titleCfg.variant,
          directory: params.directory,
          timeoutMs: 25_000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        const title = extractTitleCandidate(raw);
        if (!title) {
          this.store.markAutoTitleState(sessionID, null);
          return;
        }
        const current = this.store.getSession(sessionID);
        if (!current || !isUntitledSessionTitle(current.title)) {
          this.store.markAutoTitleState(sessionID, 'done');
          return;
        }

        const effectiveDir = params.directory || current.directory || null;
        await this.renameSessionTitle({
          sessionID,
          title,
          directory: effectiveDir,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        this.store.setSessionTitle(sessionID, title);
        const now = Date.now();
        this.sseHub.broadcast({
          type: 'session.renamed',
          created: now,
          ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
          data: { sessionID, title },
        });
      } catch {
        const current = this.store.getSession(sessionID);
        if (current && current.autoTitleState === 'pending') {
          this.store.markAutoTitleState(sessionID, null);
        }
      } finally {
        this.autoTitleControllers.delete(controller);
      }
    })();
  }

  stopAll() {
    for (const ac of [...this.autoTitleControllers]) {
      ac.abort();
    }
    this.autoTitleControllers.clear();
    for (const entry of [...this.childWatchers.values()]) {
      if (!entry.watcher.closed) {
        entry.watcher.close(entry.watcher.turnBusy ? 'cancelled' : 'completed', 'Router stopped');
      }
    }
    this.childWatchers.clear();
    this.pendingTurnQueue.clear();
    for (const sid of [...this.workers.keys()]) {
      const w = this.workers.get(sid);
      if (w?.busy) {
        this.interrupt(sid);
      } else {
        this._retireWorker(sid, false);
      }
    }
  }
}
