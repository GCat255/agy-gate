import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveAgyBinary } from './config.mjs';
import { loadMagpieAgyEnv } from './magpie-env.mjs';
import { resolveRealAgyModelId } from './agy-models.mjs';
import { AgyTurnTranslator } from './event-translator.mjs';
import { buildSpawnSpec } from './upstream.mjs';
import { buildSessionGuidancePrefix } from './openchamber-bridge.mjs';

const IS_WIN = process.platform === 'win32';
const DEFAULT_WORKER_IDLE_MS = 15 * 60_000;

/**
 * Manages persistent warm `agy-cli` workers (`--input-format stream-json`) per session
 * to eliminate per-turn cold-start latency (~8-10s) and preserve prompt prefix cache hits.
 */
export class AgyRunner {
  /**
   * @param {{ store: import('./store.mjs').RouterStore, sseHub: import('./sse-hub.mjs').SseHub, env?: NodeJS.ProcessEnv }} options
   */
  constructor(options) {
    this.store = options.store;
    this.sseHub = options.sseHub;
    this.env = options.env || process.env;
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
     *   turn: { translator: AgyTurnTranslator, sessionID: string } | null,
     * }>}
     */
    this.workers = new Map();
    this.seq = 0;
  }

  /** @param {string} sessionID */
  isRunning(sessionID) {
    return Boolean(this.workers.get(sessionID)?.busy);
  }

  activeSessionIds() {
    const ids = [];
    for (const [sid, w] of this.workers.entries()) {
      if (w.busy) ids.push(sid);
    }
    return ids;
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

      if (this.useWarmWorker && !worker.exited && this.workerIdleMs > 0) {
        if (worker.idleTimer) clearTimeout(worker.idleTimer);
        worker.idleTimer = setTimeout(() => {
          if (!worker.busy) this._retireWorker(opts.sessionID, false);
        }, this.workerIdleMs);
        worker.idleTimer.unref();
      }
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
    const translator = new AgyTurnTranslator({
      sessionID,
      assistantMessageID,
      modelID,
      variant,
      agent,
      directory,
      emit: (ev) => this.sseHub.broadcast(ev),
      onConversationId: (convId) => this.store.setAgyConversationId(sessionID, convId),
      onOpenChamberToolStart: ({ tool, callID }) => {
        try {
          fs.appendFileSync(callLogPath, `${JSON.stringify({ tool, callID, ts: Date.now() })}\n`, 'utf8');
        } catch {}
      },
    });

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
    worker.turn = { translator, sessionID };
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

  /**
   * Interrupt an active `agy-cli` turn for `sessionID`.
   * @param {string} sessionID
   */
  interrupt(sessionID) {
    const worker = this.workers.get(sessionID);
    if (!worker || !worker.busy) return false;
    worker.interrupted = true;
    this._retireWorker(sessionID, true);
    return true;
  }

  stopAll() {
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
