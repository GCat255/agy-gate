import fs from 'node:fs';
import path from 'node:path';
import { resolveAgyBinary } from '../core/config.mjs';
import { buildSessionGuidancePrefix, loadOpenChamberToolContract } from '../bridge/openchamber.mjs';
import { loadMagpieAgyEnv } from './magpie-env.mjs';
import { AGY_PROVIDER_ID, modelSupportsImageInput, resolveRealAgyModelId } from './models.mjs';
import { AgyAcpClient } from './acp-client.mjs';
import { AgyTurnTranslator, normalizeUsageBuckets } from './event-translator.mjs';
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

const DEFAULT_WORKER_IDLE_MS = 15 * 60_000;
const CANCEL_FORCE_KILL_DELAY_MS = 3_000;
const EFFORT_SUFFIX_RE = /^(.+)-(low|medium|high|xhigh|max)$/;
const IMAGE_EXT_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);

function inferImageMimeFromPathOrName(nameOrUri, explicitMime) {
  const mime = String(explicitMime || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return mime;
  const clean = String(nameOrUri || '').split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase();
  return IMAGE_EXT_MIME.get(ext) || null;
}

function parseDataImageUri(uri, fallbackName, explicitMime) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return null;
  const commaIdx = uri.indexOf(',');
  if (commaIdx < 0) return null;
  const meta = uri.slice(5, commaIdx);
  const body = uri.slice(commaIdx + 1);
  const parts = meta.split(';').map((p) => p.trim().toLowerCase());
  const isBase64 = parts.includes('base64');
  const declaredMime = parts[0] && parts[0].includes('/') ? parts[0] : '';
  const mimeType = inferImageMimeFromPathOrName(fallbackName, declaredMime || explicitMime);
  if (!mimeType) return null;

  const data = isBase64 ? body : Buffer.from(decodeURIComponent(body), 'utf8').toString('base64');
  if (!data) return null;
  return { mimeType, data };
}

function tryReadLocalImageFile(uriOrPath, fallbackName, explicitMime) {
  const localPath = fileUriToPath(uriOrPath);
  if (!localPath) return null;
  const mimeType = inferImageMimeFromPathOrName(localPath, explicitMime)
    || inferImageMimeFromPathOrName(fallbackName, explicitMime);
  if (!mimeType) return null;
  try {
    if (!fs.existsSync(localPath)) return null;
    const data = fs.readFileSync(localPath).toString('base64');
    if (!data) return null;
    return { mimeType, data };
  } catch {
    return null;
  }
}

function extractCreatedSubagentJson(content) {
  const text = String(content || '');
  const idx = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (idx < 0 || last <= idx) return null;
  try {
    const parsed = JSON.parse(text.slice(idx, last + 1));
    if (parsed && typeof parsed === 'object' && typeof parsed.conversationId === 'string') {
      return parsed;
    }
  } catch {
    // Not a subagent creation JSON block
  }
  return null;
}

function extractCheckpointSummary(content) {
  const raw = String(content || '').trim();
  if (!raw) return '';
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match ? match[1] : raw).trim();
}

function splitConcreteModelAndEffort(realModelID, explicitVariant) {
  const id = String(realModelID || '').trim();
  const match = id.match(EFFORT_SUFFIX_RE);
  if (match) {
    return {
      concreteId: id,
      baseModelId: match[1],
      effort: explicitVariant || match[2],
    };
  }
  return {
    concreteId: id,
    baseModelId: id,
    effort: explicitVariant || null,
  };
}

/**
 * Manages persistent warm `agy acp` workers per session
 * to eliminate cold-start latency, preserve prompt cache hits, and support native multimodal inputs.
 */
export class AgyRunner {
  /**
   * @param {{
   *   store: import('../gateway/store.mjs').RouterStore,
   *   sseHub: import('../gateway/sse-hub.mjs').SseHub,
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
     *   client: AgyAcpClient,
     *   acpSessionId: string,
     *   cwd: string,
     *   appliedModelKey: string | null,
     *   busy: boolean,
     *   exited: boolean,
     *   interrupted: boolean,
     *   hadFirstTurn: boolean,
     *   idleTimer: NodeJS.Timeout | null,
     *   cancelTimer: NodeJS.Timeout | null,
     *   turn: any,
     * }>}
     */
    this.workers = new Map();
    /** @type {Map<string, { translator: AgyTurnTranslator, directory?: string | null, aborted: boolean, client: AgyAcpClient | null }>} */
    this.startingSessions = new Map();
    /** @type {Map<string, { watcher: AgySubagentWatcher, parentSessionID: string }>} */
    this.childWatchers = new Map();
    /** @type {Map<string, Array<{ messageID?: string, modelID: string, variant?: string, directory?: string | null, promptPayload: any }>>} */
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
    return this.startingSessions.has(sessionID) || Boolean(this.workers.get(sessionID)?.busy);
  }

  activeSessionIds() {
    const ids = new Set();
    for (const sid of this.startingSessions.keys()) ids.add(sid);
    for (const [sid, w] of this.workers.entries()) {
      if (w.busy) ids.add(sid);
    }
    for (const [cid, entry] of this.childWatchers.entries()) {
      if (!entry.watcher.closed && entry.watcher.turnBusy) ids.add(cid);
    }
    return [...ids];
  }

  /**
   * Return a live snapshot of an active turn's in-flight `assistant` message (if any)
   * so `GET /api/session/:id/message` survives browser reloads and session switching.
   * @param {string} sessionID
   */
  getInFlightAssistantMessage(sessionID) {
    const starting = this.startingSessions.get(sessionID);
    if (starting?.translator) {
      return starting.translator.toInFlightAssistantMessage();
    }
    const worker = this.workers.get(sessionID);
    if (worker?.busy && worker.turn?.translator?.toInFlightAssistantMessage) {
      return worker.turn.translator.toInFlightAssistantMessage();
    }
    return null;
  }

  /**
   * Queue a follow-up turn payload when the session is currently busy.
   * @param {string} sessionID
   * @param {{ messageID?: string, modelID: string, variant?: string, directory?: string | null, promptPayload: any }} item
   */
  enqueueTurnInput(sessionID, item) {
    const list = this.pendingTurnQueue.get(sessionID) || [];
    list.push(item);
    this.pendingTurnQueue.set(sessionID, list);
  }

  _clearPendingQueueOnInterrupt(sessionID) {
    const list = this.pendingTurnQueue.get(sessionID);
    if (!list || list.length === 0) return;
    this.pendingTurnQueue.delete(sessionID);
    const sessionState = this.store.getSession(sessionID);
    const effectiveDir = sessionState?.directory || null;
    const loc = effectiveDir ? { location: { directory: effectiveDir } } : {};
    const now = Date.now();
    for (const item of list) {
      if (!item?.messageID) continue;
      this.store.deleteMessage?.(sessionID, item.messageID);
      this.sseHub.broadcast({
        type: 'session.inbox.cancelled',
        created: now,
        ...loc,
        data: { sessionID, inboxID: item.messageID },
      });
    }
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
    if (next.messageID) {
      const effectiveDir = next.directory || this.store.getSession(sessionID)?.directory || null;
      this.sseHub.broadcast({
        type: 'session.inbox.delivered',
        created: Date.now(),
        ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
        data: { sessionID, inboxID: next.messageID },
      });
    }
    await this.startTurn({
      sessionID,
      modelID: next.modelID,
      variant: next.variant,
      directory: next.directory,
      promptPayload: next.promptPayload,
    });
  }

  _handleSubagentDiscovered(parentSessionID, parentModelID, cwd, info, worker) {
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
        const activeTranslator = worker?.turn?.translator || this.workers.get(parentSessionID)?.turn?.translator;
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
   * Build ACP `session/prompt` content blocks (`text` + native `image` blocks).
   * @param {{ text?: string, files?: any[], skills?: any[] }} payload
   * @param {{ syntheticTexts?: string[], guidancePrefix?: string | null, allowImages?: boolean }} [options]
   */
  buildPromptBlocks(payload, options = {}) {
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

    const allowImages = options.allowImages !== false;
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const imageBlocks = [];
    const textHints = [];

    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const uri = file.uri || file.url || (file.source?.type === 'uri' ? file.source.uri : null);
      const label = file.name || file.filename || file.mime || file.mimeType || 'attachment';
      const explicitMime = file.mime || file.mimeType;

      let decodedImage = null;
      if (allowImages && typeof uri === 'string' && uri.trim()) {
        decodedImage =
          parseDataImageUri(uri.trim(), label, explicitMime)
          || tryReadLocalImageFile(uri.trim(), label, explicitMime);
      }

      if (decodedImage) {
        imageBlocks.push({
          type: 'image',
          mimeType: decodedImage.mimeType,
          data: decodedImage.data,
        });
      } else if (typeof uri === 'string' && uri.trim()) {
        textHints.push(`- ${label}: ${uri.trim()}`);
      } else {
        textHints.push(`- ${label} (${explicitMime || 'inline'})`);
      }
    }

    if (textHints.length > 0) {
      sections.push(['[Attached files]', ...textHints].join('\n'));
    }

    const text = sections.filter(Boolean).join('\n\n');
    const blocks = [];
    if (text) {
      blocks.push({ type: 'text', text });
    }
    for (const img of imageBlocks) {
      blocks.push(img);
    }
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '' });
    }

    return { blocks, text };
  }

  /**
   * Build child environment and base CLI flags for `agy acp`.
   * @param {{ sessionID?: string, cwd?: string, callLogPath?: string }} opts
   */
  _buildAgySpawnConfig(opts = {}) {
    const agyBin = resolveAgyBinary(this.env);
    if (!agyBin) return null;

    const useMagpie = this.env.AGY_ROUTER_USE_MAGPIE === '1';
    const childEnv = { ...this.env };
    if (opts.sessionID) childEnv.OPENCHAMBER_ROUTER_SESSION_ID = opts.sessionID;
    if (opts.cwd) childEnv.OPENCHAMBER_ROUTER_DIRECTORY = opts.cwd;
    if (opts.callLogPath) childEnv.OPENCHAMBER_ROUTER_CALL_LOG = opts.callLogPath;

    const args = ['acp'];
    if (useMagpie) {
      const magpie = loadMagpieAgyEnv({ env: this.env });
      Object.assign(childEnv, magpie.envPatch);
      if (magpie.settingsPath) args.push('--settings', magpie.settingsPath);
    } else {
      delete childEnv.GEMINI_API_KEY;
      delete childEnv.GOOGLE_GEMINI_BASE_URL;
    }

    if (this.env.AGY_ROUTER_AGY_AUTO_APPROVE !== '0') {
      args.push('--dangerously-skip-permissions');
    }

    return { agyBin, childEnv, args };
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
    if (w.cancelTimer) {
      clearTimeout(w.cancelTimer);
      w.cancelTimer = null;
    }
    this.workers.delete(sessionID);
    w.exited = true;
    w.client.close(forceKill);
  }

  /**
   * Incrementally read main session `transcript.jsonl` to discover newly spawned subagents
   * (since ACP `invoke_subagent` `tool_call_update` omits `conversationId` / `logUri`)
   * and child wakeup messages.
   * @param {any} worker
   */
  _syncMainTranscriptForSubagents(worker) {
    const turn = worker?.turn;
    const acpSessionId = worker?.acpSessionId;
    if (!turn || !acpSessionId) return;

    const transcriptPath = resolveBrainTranscriptPath(acpSessionId, this.env.AGY_ROUTER_HOME_DIR || undefined);
    if (!transcriptPath) return;

    const lines = readTranscriptLines(transcriptPath);
    if (!lines || lines.length <= turn.transcriptLineOffset) return;

    for (let i = turn.transcriptLineOffset; i < lines.length; i += 1) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;

      if (entry.type === 'SYSTEM_MESSAGE') {
        this._flushSubagentWatchersForParent(turn.sessionID, { cancelRemaining: false, settleReplyNow: false });
        continue;
      }

      if (entry.type === 'CHECKPOINT' && typeof entry.content === 'string') {
        const summary = extractCheckpointSummary(entry.content);
        if (summary) turn.checkpointSummary = summary;
        continue;
      }

      if (entry.type === 'GENERIC' && typeof entry.content === 'string') {
        const created = extractCreatedSubagentJson(entry.content);
        if (created && !turn.discoveredSubagentConvIds.has(created.conversationId)) {
          turn.discoveredSubagentConvIds.add(created.conversationId);
          const childSessionID = toChildSessionID(created.conversationId);
          turn.translator.attachDiscoveredSubagent(childSessionID);
          const matchingSub = turn.translator.activeSubagents.find((s) => s.childSessionID === childSessionID);
          const ts = entry.created_at ? Date.parse(entry.created_at) || Date.now() : Date.now();
          this._handleSubagentDiscovered(
            turn.sessionID,
            turn.modelID,
            worker.cwd,
            {
              childSessionID,
              agyConversationId: created.conversationId,
              agent: matchingSub?.input?.agent || 'subagent',
              title: matchingSub?.input?.description || 'Subagent',
              prompt: matchingSub?.input?.prompt || '',
              logUri: created.logAbsoluteUri || null,
              workspaceUris: Array.isArray(created.workspaceUris) ? created.workspaceUris : [],
              startedAt: ts,
            },
            worker,
          );
        }
      }
    }

    turn.transcriptLineOffset = lines.length;
    if (turn.subagentSyncTimer && turn.translator.activeSubagents.every((s) => s.notified || s.closed)) {
      clearInterval(turn.subagentSyncTimer);
      turn.subagentSyncTimer = null;
    }
  }

  _scheduleSubagentTranscriptPoll(worker) {
    const turn = worker?.turn;
    if (!turn || turn.subagentSyncTimer) return;
    let attempts = 0;
    turn.subagentSyncTimer = setInterval(() => {
      attempts += 1;
      if (!worker.turn || worker.turn !== turn || attempts > 25) {
        clearInterval(turn.subagentSyncTimer);
        turn.subagentSyncTimer = null;
        return;
      }
      this._syncMainTranscriptForSubagents(worker);
    }, 80);
    turn.subagentSyncTimer.unref?.();
  }

  /**
   * Apply model and reasoning effort via ACP `session/set_model` and `session/set_config_option`.
   * @param {AgyAcpClient} client
   * @param {string} acpSessionId
   * @param {string} realModelID
   * @param {string | undefined} variant
   */
  async _applySessionModel(client, acpSessionId, realModelID, variant) {
    const { concreteId, baseModelId, effort } = splitConcreteModelAndEffort(realModelID, variant);
    if (concreteId) {
      await client.request('session/set_model', { sessionId: acpSessionId, modelId: concreteId });
    }
    if (effort) {
      try {
        await client.request('session/set_config_option', {
          sessionId: acpSessionId,
          configId: 'thought_level',
          value: effort,
        });
      } catch {
        // Ignore when the target model exposes a fixed or single reasoning tier
      }
    } else if (baseModelId && baseModelId !== concreteId) {
      try {
        await client.request('session/set_config_option', {
          sessionId: acpSessionId,
          configId: 'model',
          value: baseModelId,
        });
      } catch {
        // Optional
      }
    }
  }

  /**
   * Spawn and initialize a session-scoped `agy acp` worker.
   * @param {{ sessionID: string, cwd: string, callLogPath: string, existingConvId: string | null }} opts
   */
  async _spawnAndInitWorker(opts) {
    const cfg = this._buildAgySpawnConfig({
      sessionID: opts.sessionID,
      cwd: opts.cwd,
      callLogPath: opts.callLogPath,
    });
    if (!cfg) return null;

    let worker = null;
    const client = new AgyAcpClient({
      agyBin: cfg.agyBin,
      args: cfg.args,
      cwd: opts.cwd,
      env: cfg.childEnv,
      onNotification: (method, params) => {
        if (method !== 'session/update' || !worker?.turn) return;
        const update = params?.update;
        if (!update) return;
        worker.turn.translator.handleAcpUpdate(update);
      },
      onClose: ({ code, stderr }) => {
        if (!worker) return;
        worker.exited = true;
        if (worker.idleTimer) {
          clearTimeout(worker.idleTimer);
          worker.idleTimer = null;
        }
        if (worker.cancelTimer) {
          clearTimeout(worker.cancelTimer);
          worker.cancelTimer = null;
        }
        if (this.workers.get(opts.sessionID) === worker) {
          this.workers.delete(opts.sessionID);
        }
        if (worker.turn) {
          if (worker.interrupted) {
            this._settleTurn(worker, opts.sessionID, 'interrupt');
          } else if (code === 0) {
            this._settleTurn(worker, opts.sessionID, 'complete');
          } else {
            this._settleTurn(worker, opts.sessionID, 'fail', stderr.trim() || `agy acp exited with code ${code}`);
          }
        }
      },
    });

    if (opts.onClientCreated) opts.onClientCreated(client);

    worker = {
      client,
      acpSessionId: '',
      cwd: opts.cwd,
      appliedModelKey: null,
      busy: false,
      exited: false,
      interrupted: false,
      hadFirstTurn: Boolean(opts.existingConvId),
      idleTimer: null,
      cancelTimer: null,
      turn: null,
    };

    try {
      await client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        20_000,
      );

      let sessionResult = null;
      if (opts.existingConvId) {
        try {
          sessionResult = await client.request(
            'session/resume',
            {
              sessionId: opts.existingConvId,
              cwd: opts.cwd,
              mcpServers: [],
            },
            20_000,
          );
        } catch {
          sessionResult = null;
        }
      }
      if (!sessionResult?.sessionId) {
        sessionResult = await client.request(
          'session/new',
          {
            cwd: opts.cwd,
            mcpServers: [],
          },
          20_000,
        );
      }

      worker.acpSessionId = String(sessionResult.sessionId || '');
      if (worker.acpSessionId) {
        this.store.setAgyConversationId(opts.sessionID, worker.acpSessionId);
      }
      return worker;
    } catch (err) {
      client.close(true);
      throw err;
    }
  }

  _settleTurn(worker, sessionID, outcome, payload) {
    const activeTurn = worker.turn;
    if (!activeTurn) return;
    if (activeTurn.subagentSyncTimer) {
      clearInterval(activeTurn.subagentSyncTimer);
      activeTurn.subagentSyncTimer = null;
    }
    if (worker.cancelTimer) {
      clearTimeout(worker.cancelTimer);
      worker.cancelTimer = null;
    }

    this._syncMainTranscriptForSubagents(worker);
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
      assistantMsg = activeTurn.translator.fail(payload);
    } else if (payload && typeof payload === 'object') {
      if (
        activeTurn.checkpointSummary
        && activeTurn.translator.content.length === 0
        && !activeTurn.translator.openStream
      ) {
        activeTurn.translator._appendStreamDelta('text', activeTurn.checkpointSummary);
      }
      assistantMsg = activeTurn.translator.completeFromPromptResult(payload);
    } else {
      assistantMsg = activeTurn.translator.complete();
    }

    if (assistantMsg) {
      this.store.upsertMessage(activeTurn.sessionID, assistantMsg);
    }
    if (outcome === 'complete' && assistantMsg && assistantMsg.finish === 'stop') {
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
    if (activeTurn.translator.tokens && (activeTurn.translator.tokens.input > 0 || activeTurn.translator.tokens.output > 0)) {
      this.store.recordTurnUsage(activeTurn.sessionID, {
        sessionTokens: activeTurn.translator.sessionTokens,
      });
    }

    if (!this.useWarmWorker) {
      this._retireWorker(sessionID, false);
    } else if (!worker.exited && this.workerIdleMs > 0) {
      if (worker.idleTimer) clearTimeout(worker.idleTimer);
      worker.idleTimer = setTimeout(() => {
        if (!worker.busy) this._retireWorker(sessionID, false);
      }, this.workerIdleMs);
      worker.idleTimer.unref();
    }

    queueMicrotask(() => {
      void this._drainPendingQueue(activeTurn.sessionID);
    });
  }

  /**
   * Start an `agy acp` turn asynchronously, reusing the session's warm ACP worker when compatible.
   * @param {{ sessionID: string, modelID: string, variant?: string, realModelID?: string, agent?: string, directory?: string | null, promptPayload: any }} params
   */
  async startTurn(params) {
    const { sessionID, modelID, variant, agent, directory, promptPayload } = params;
    const existing = this.workers.get(sessionID);
    if (this.startingSessions.has(sessionID) || existing?.busy) {
      return { ok: false, reason: 'busy' };
    }

    const sessionState = this.store.getSession(sessionID);
    const realModelID = params.realModelID || resolveRealAgyModelId(modelID, variant, { env: this.env });
    const cwd = directory && fs.existsSync(directory) ? directory : process.cwd();
    const safeSession = String(sessionID).replace(/[^a-zA-Z0-9._-]/g, '_');
    const callLogPath = path.join(this.store.sessionsDir, `${safeSession}.calls.jsonl`);
    const assistantMessageID = `msg_${Date.now()}_${++this.seq}`;

    const translator = new AgyTurnTranslator({
      sessionID,
      assistantMessageID,
      modelID,
      variant,
      agent,
      directory,
      priorSessionTokens: sessionState?.sessionTokens || null,
      emit: (ev) => this.sseHub.broadcast(ev),
      onOpenChamberToolStart: ({ tool, callID }) => {
        try {
          fs.appendFileSync(callLogPath, `${JSON.stringify({ tool, callID, ts: Date.now() })}\n`, 'utf8');
        } catch {}
      },
      onSyncSubagents: () => {
        const w = this.workers.get(sessionID);
        if (!w) return;
        this._syncMainTranscriptForSubagents(w);
        if (w.turn?.translator?.activeSubagents?.some((s) => !s.notified && !s.closed)) {
          this._scheduleSubagentTranscriptPoll(w);
        }
      },
      onSubagentWake: ({ recipientId }) => this.wakeSubagentWatcher(sessionID, recipientId),
      onSubagentKilled: (killInfo) => this.handleSubagentKill(sessionID, killInfo),
    });

    const startingEntry = { translator, directory, aborted: false, client: null };
    this.startingSessions.set(sessionID, startingEntry);
    translator.begin();

    let worker = null;
    try {
      void loadOpenChamberToolContract({ env: this.env })
        .then((contract) => {
          if (contract && !translator.toolContract) translator.toolContract = contract;
        })
        .catch(() => {});
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
      const { blocks } = this.buildPromptBlocks(promptPayload, {
        syntheticTexts,
        guidancePrefix,
        allowImages: modelSupportsImageInput(realModelID),
      });

      const canReuse =
        this.useWarmWorker
        && existing
        && !existing.exited
        && !existing.busy
        && existing.cwd === cwd;

      worker = canReuse ? existing : null;
      if (!worker) {
        if (existing) this._retireWorker(sessionID, false);
        try {
          fs.unlinkSync(callLogPath);
        } catch {}
        worker = await this._spawnAndInitWorker({
          sessionID,
          cwd,
          callLogPath,
          existingConvId: sessionState?.agyConversationId || null,
          onClientCreated: (client) => {
            startingEntry.client = client;
          },
        });
        if (!worker) {
          const msg = translator.fail('agy executable not found on this machine');
          if (msg) this.store.upsertMessage(sessionID, msg);
          return { ok: true };
        }
        this.workers.set(sessionID, worker);
      }

      if (startingEntry.aborted) {
        this._retireWorker(sessionID, true);
        const msg = translator.interrupt('user');
        if (msg) this.store.upsertMessage(sessionID, msg);
        return { ok: true };
      }

      if (worker.idleTimer) {
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
      }

      const existingConvId = worker.acpSessionId || sessionState?.agyConversationId || null;
      const initialTranscriptPath = existingConvId
        ? resolveBrainTranscriptPath(existingConvId, this.env.AGY_ROUTER_HOME_DIR || undefined)
        : null;
      const startTranscriptLineOffset = initialTranscriptPath
        ? (readTranscriptLines(initialTranscriptPath)?.length ?? 0)
        : 0;

      const turnState = {
        translator,
        sessionID,
        modelID,
        directory,
        userText: String(promptPayload?.text || '').trim(),
        transcriptLineOffset: startTranscriptLineOffset,
        discoveredSubagentConvIds: new Set(),
        subagentSyncTimer: null,
      };

      worker.busy = true;
      worker.interrupted = false;
      worker.hadFirstTurn = true;
      worker.turn = turnState;

      const modelKey = `${modelID}|${variant || ''}|${realModelID}`;
      if (worker.appliedModelKey !== modelKey) {
        await this._applySessionModel(worker.client, worker.acpSessionId, realModelID, variant);
        worker.appliedModelKey = modelKey;
      }

      if (startingEntry.aborted || worker.interrupted) {
        this._settleTurn(worker, sessionID, 'interrupt');
        return { ok: true };
      }

      void worker.client
        .request('session/prompt', {
          sessionId: worker.acpSessionId,
          prompt: blocks,
        })
        .then(
          (result) => {
            if (!worker.turn) return;
            if (result?.stopReason === 'cancelled' || worker.interrupted) {
              if (result?.usage) worker.turn.translator.recordPromptUsage(result.usage);
              this._settleTurn(worker, sessionID, 'interrupt');
            } else {
              this._settleTurn(worker, sessionID, 'complete', result);
            }
          },
          (err) => {
            if (!worker.turn) return;
            if (worker.interrupted) {
              this._settleTurn(worker, sessionID, 'interrupt');
            } else {
              this._settleTurn(worker, sessionID, 'fail', err?.message || String(err));
            }
          },
        );

      return { ok: true };
    } catch (err) {
      if (worker && worker.turn) {
        this._settleTurn(worker, sessionID, startingEntry.aborted ? 'interrupt' : 'fail', err?.message || String(err));
      } else {
        const msg = startingEntry.aborted
          ? translator.interrupt('user')
          : translator.fail(err?.message || 'Failed to start agy acp turn');
        if (msg) this.store.upsertMessage(sessionID, msg);
      }
      return { ok: true };
    } finally {
      this.startingSessions.delete(sessionID);
    }
  }

  /**
   * Compact an existing `agy-cli` session via ACP `/compact` and emit OpenCode
   * `session.compaction.*` SSE events + persisted `compaction` message.
   * @param {{ sessionID: string, modelID: string, variant?: string, directory?: string | null, messageID?: string }} params
   */
  async compactSession(params) {
    const { sessionID, modelID, variant, directory } = params;
    const existing = this.workers.get(sessionID);
    if (this.startingSessions.has(sessionID) || existing?.busy) {
      return { ok: false, status: 409, error: 'Session is busy' };
    }

    const sessionState = this.store.getSession(sessionID);
    const hasHistory = Boolean(sessionState?.agyConversationId) || this.store.getMessages(sessionID).length > 0;
    if (!hasHistory) {
      return { ok: false, status: 400, error: 'Nothing to compact yet' };
    }

    const startingCompact = { translator: null, directory, aborted: false, client: null };
    this.startingSessions.set(sessionID, startingCompact);
    const created = Date.now();
    const compactBaseId = `${created}_${++this.seq}`;
    const rawMsgId = typeof params.messageID === 'string' && params.messageID.trim() ? params.messageID.trim() : null;
    const messageID = rawMsgId || `msg_${compactBaseId}`;
    const eventID = rawMsgId && rawMsgId.startsWith('msg_') ? `evt_${rawMsgId.slice(4)}` : `evt_${compactBaseId}`;
    const effectiveDir = directory || sessionState?.directory || null;
    const loc = effectiveDir ? { location: { directory: effectiveDir } } : {};
    const modelRef = {
      providerID: AGY_PROVIDER_ID,
      id: modelID,
      ...(variant ? { variant } : {}),
    };

    const emitCompactionFailed = (message) => {
      const now = Date.now();
      const errObj = { type: 'unknown', message: String(message || 'Compaction failed') };
      this.store.upsertMessage(sessionID, {
        id: messageID,
        type: 'compaction',
        status: 'failed',
        reason: 'manual',
        summary: '',
        error: errObj,
        cost: 0,
        time: { created },
      });
      this.sseHub.broadcast({
        id: eventID,
        type: 'session.compaction.failed',
        created: now,
        ...loc,
        data: {
          sessionID,
          reason: 'manual',
          inputID: messageID,
          error: errObj,
        },
      });
      this.sseHub.broadcast({
        type: 'session.execution.failed',
        created: now,
        ...loc,
        data: { sessionID, error: errObj },
      });
      this.sseHub.broadcast({
        type: 'session.idle',
        created: now,
        ...loc,
        data: { sessionID },
      });
    };

    try {
      const realModelID = resolveRealAgyModelId(modelID, variant, { env: this.env });
      const cwd = effectiveDir && fs.existsSync(effectiveDir) ? effectiveDir : process.cwd();
      const safeSession = String(sessionID).replace(/[^a-zA-Z0-9._-]/g, '_');
      const callLogPath = path.join(this.store.sessionsDir, `${safeSession}.calls.jsonl`);

      const canReuse =
        this.useWarmWorker
        && existing
        && !existing.exited
        && !existing.busy
        && existing.cwd === cwd;

      let worker = canReuse ? existing : null;
      if (!worker) {
        if (existing) this._retireWorker(sessionID, false);
        worker = await this._spawnAndInitWorker({
          sessionID,
          cwd,
          callLogPath,
          existingConvId: sessionState?.agyConversationId || null,
          onClientCreated: (client) => {
            startingCompact.client = client;
          },
        });
        if (!worker) {
          emitCompactionFailed('agy executable not found on this machine');
          return { ok: true, messageID, created };
        }
        this.workers.set(sessionID, worker);
      }

      if (worker.idleTimer) {
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
      }

      const transcriptPath = worker.acpSessionId
        ? resolveBrainTranscriptPath(worker.acpSessionId, this.env.AGY_ROUTER_HOME_DIR || undefined)
        : null;
      const startLineOffset = transcriptPath ? (readTranscriptLines(transcriptPath)?.length ?? 0) : 0;

      // Dummy translator handles `onClose` / `interrupt` cleanly if worker drops mid-compact
      let checkpointSummary = '';
      let streamedText = '';
      const compactTurn = {
        sessionID,
        modelID,
        directory: effectiveDir,
        transcriptLineOffset: startLineOffset,
        discoveredSubagentConvIds: new Set(),
        translator: {
          activeSubagents: [],
          content: [],
          openStream: null,
          tokens: null,
          sessionTokens: sessionState?.sessionTokens || null,
          handleAcpUpdate: (update) => {
            if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
              streamedText += update.content.text;
            }
          },
          interrupt: () => {
            emitCompactionFailed('Compaction interrupted');
            return null;
          },
          fail: (msg) => {
            emitCompactionFailed(msg);
            return null;
          },
        },
      };

      worker.busy = true;
      worker.interrupted = false;
      worker.hadFirstTurn = true;
      worker.turn = compactTurn;

      this.store.upsertMessage(sessionID, {
        id: messageID,
        type: 'compaction',
        status: 'running',
        reason: 'manual',
        summary: '',
        time: { created },
      });
      this.sseHub.broadcast({
        type: 'session.execution.started',
        created,
        ...loc,
        data: { sessionID },
      });
      this.sseHub.broadcast({
        id: eventID,
        type: 'session.compaction.started',
        created,
        ...loc,
        data: {
          sessionID,
          reason: 'manual',
          inputID: messageID,
        },
      });

      const modelKey = `${modelID}|${variant || ''}|${realModelID}`;
      if (worker.appliedModelKey !== modelKey) {
        await this._applySessionModel(worker.client, worker.acpSessionId, realModelID, variant);
        worker.appliedModelKey = modelKey;
      }

      void worker.client
        .request('session/prompt', {
          sessionId: worker.acpSessionId,
          prompt: [{ type: 'text', text: '/compact' }],
        })
        .then(
          (result) => {
            if (worker.turn !== compactTurn) return;
            if (worker.cancelTimer) {
              clearTimeout(worker.cancelTimer);
              worker.cancelTimer = null;
            }
            worker.turn = null;
            worker.busy = false;

            if (result?.stopReason === 'cancelled' || worker.interrupted) {
              emitCompactionFailed('Compaction cancelled');
              return;
            }

            if (transcriptPath) {
              const lines = readTranscriptLines(transcriptPath);
              if (lines && lines.length > startLineOffset) {
                for (let i = startLineOffset; i < lines.length; i += 1) {
                  try {
                    const entry = JSON.parse(lines[i]);
                    if (entry?.type === 'CHECKPOINT' && typeof entry.content === 'string') {
                      const extracted = extractCheckpointSummary(entry.content);
                      if (extracted) checkpointSummary = extracted;
                    }
                  } catch {}
                }
              }
            }

            const summary = checkpointSummary || streamedText.trim() || 'Conversation compacted.';
            const parsedUsage = normalizeUsageBuckets(result?.usage);
            const turnTokens = parsedUsage
              ? {
                  input: parsedUsage.input,
                  output: parsedUsage.output,
                  reasoning: parsedUsage.reasoning,
                  cache: { ...parsedUsage.cache },
                }
              : undefined;
            const prevSession = sessionState?.sessionTokens || {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            };
            const nextSessionTokens = turnTokens
              ? {
                  input: (prevSession.input || 0) + turnTokens.input,
                  output: (prevSession.output || 0) + turnTokens.output,
                  reasoning: (prevSession.reasoning || 0) + turnTokens.reasoning,
                  cache: {
                    read: (prevSession.cache?.read || 0) + turnTokens.cache.read,
                    write: (prevSession.cache?.write || 0) + turnTokens.cache.write,
                  },
                }
              : prevSession;

            if (turnTokens) {
              this.store.recordTurnUsage(sessionID, { sessionTokens: nextSessionTokens });
            }

            const completedAt = Date.now();
            this.store.upsertMessage(sessionID, {
              id: messageID,
              type: 'compaction',
              status: 'completed',
              reason: 'manual',
              summary,
              model: modelRef,
              cost: 0,
              ...(turnTokens ? { tokens: turnTokens } : {}),
              time: { created, completed: completedAt },
            });

            this.sseHub.broadcast({
              type: 'session.compaction.delta',
              created: completedAt,
              ...loc,
              data: { sessionID, text: summary },
            });
            this.sseHub.broadcast({
              id: eventID,
              type: 'session.compaction.ended',
              created: completedAt,
              ...loc,
              data: {
                sessionID,
                reason: 'manual',
                model: modelRef,
                text: summary,
                cost: 0,
                ...(turnTokens ? { tokens: turnTokens } : {}),
              },
            });
            if (turnTokens) {
              this.sseHub.broadcast({
                type: 'session.usage.updated',
                created: completedAt,
                ...loc,
                data: { sessionID, cost: 0, tokens: nextSessionTokens },
              });
            }
            this.sseHub.broadcast({
              type: 'session.execution.succeeded',
              created: completedAt,
              ...loc,
              data: { sessionID },
            });
            this.sseHub.broadcast({
              type: 'session.idle',
              created: completedAt,
              ...loc,
              data: { sessionID },
            });

            if (!this.useWarmWorker) {
              this._retireWorker(sessionID, false);
            } else if (!worker.exited && this.workerIdleMs > 0) {
              if (worker.idleTimer) clearTimeout(worker.idleTimer);
              worker.idleTimer = setTimeout(() => {
                if (!worker.busy) this._retireWorker(sessionID, false);
              }, this.workerIdleMs);
              worker.idleTimer.unref();
            }
            queueMicrotask(() => {
              void this._drainPendingQueue(sessionID);
            });
          },
          (err) => {
            if (worker.turn !== compactTurn) return;
            if (worker.cancelTimer) {
              clearTimeout(worker.cancelTimer);
              worker.cancelTimer = null;
            }
            worker.turn = null;
            worker.busy = false;
            emitCompactionFailed(err?.message || String(err));
          },
        );

      return { ok: true, messageID, created };
    } catch (err) {
      emitCompactionFailed(err?.message || 'Failed to compact session');
      return { ok: true, messageID, created };
    } finally {
      this.startingSessions.delete(sessionID);
    }
  }

  /**
   * Run a stateless one-shot text generation via `agy acp` for `/api/experimental/generate/text`.
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
    const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : 55_000;

    return new Promise((resolve, reject) => {
      let settled = false;
      let deltaText = '';
      let timer = null;
      let client = null;

      const finish = (err, text) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (params.signal) params.signal.removeEventListener('abort', onAbort);
        client?.close(true);
        if (err) reject(err);
        else resolve(text ?? '');
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

      timer = setTimeout(() => {
        finish(new Error(`agy-cli text generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      client = new AgyAcpClient({
        agyBin: cfg.agyBin,
        args: cfg.args,
        cwd,
        env: cfg.childEnv,
        onNotification: (method, nParams) => {
          if (method !== 'session/update') return;
          const u = nParams?.update;
          if (u?.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') {
            deltaText += u.content.text;
          }
        },
        onClose: ({ code, stderr }) => {
          if (settled) return;
          if (code === 0 && deltaText) {
            finish(null, deltaText);
          } else {
            finish(new Error(stderr.trim() || `agy acp exited with code ${code}`));
          }
        },
      });

      void (async () => {
        try {
          await client.request(
            'initialize',
            {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            },
            20_000,
          );
          const created = await client.request('session/new', { cwd, mcpServers: [] }, 20_000);
          const sid = String(created.sessionId || '');
          await this._applySessionModel(client, sid, realModelID, params.variant);
          await client.request('session/prompt', {
            sessionId: sid,
            prompt: [{ type: 'text', text: String(params.prompt || '') }],
          });
          finish(null, deltaText);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
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
    this._clearPendingQueueOnInterrupt(sessionID);
    const starting = this.startingSessions.get(sessionID);
    if (starting) {
      starting.aborted = true;
      starting.client?.close(true);
      const w = this.workers.get(sessionID);
      if (w) {
        w.interrupted = true;
        if (w.acpSessionId) w.client.notify('session/cancel', { sessionId: w.acpSessionId });
      }
      return true;
    }
    const worker = this.workers.get(sessionID);
    if (!worker || !worker.busy) return false;
    worker.interrupted = true;
    if (worker.acpSessionId) {
      worker.client.notify('session/cancel', { sessionId: worker.acpSessionId });
    }
    if (!worker.cancelTimer) {
      worker.cancelTimer = setTimeout(() => {
        if (worker.busy) this._retireWorker(sessionID, true);
      }, CANCEL_FORCE_KILL_DELAY_MS);
      worker.cancelTimer.unref?.();
    }
    return true;
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
      this._retireWorker(sid, true);
    }
  }
}
