import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolveAgyBinary } from './config.mjs';
import { loadMagpieAgyEnv } from './magpie-env.mjs';
import { AgyTurnTranslator } from './event-translator.mjs';
import { buildSpawnSpec } from './upstream.mjs';

const IS_WIN = process.platform === 'win32';

/**
 * Manages active and completed `agy-cli` executions per OpenChamber `sessionID`.
 */
export class AgyRunner {
  /**
   * @param {{ store: import('./store.mjs').RouterStore, sseHub: import('./sse-hub.mjs').SseHub, env?: NodeJS.ProcessEnv }} options
   */
  constructor(options) {
    this.store = options.store;
    this.sseHub = options.sseHub;
    this.env = options.env || process.env;
    /** @type {Map<string, { child: import('node:child_process').ChildProcess, interrupted: boolean }>} */
    this.active = new Map();
    this.seq = 0;
  }

  /** @param {string} sessionID */
  isRunning(sessionID) {
    return this.active.has(sessionID);
  }

  activeSessionIds() {
    return [...this.active.keys()];
  }

  /**
   * Format prompt text including any file attachments sent from OpenChamber.
   * @param {{ text?: string, files?: any[] }} payload
   */
  buildPromptText(payload) {
    const base = String(payload?.text || '').trim();
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (files.length === 0) return base;

    const hints = [];
    for (const file of files) {
      const label = file.name || file.mime || 'attachment';
      const uri = file.source?.type === 'uri' ? file.source.uri : null;
      if (uri) hints.push(`- ${label}: ${uri}`);
      else hints.push(`- ${label} (${file.mime || 'inline'})`);
    }
    return [base, '', '[Attached files]', ...hints].filter(Boolean).join('\n');
  }

  /**
   * Start an `agy-cli` turn asynchronously and stream events via `sseHub`.
   * @param {{ sessionID: string, modelID: string, agent?: string, directory?: string | null, promptPayload: any }} params
   */
  startTurn(params) {
    const { sessionID, modelID, agent, directory, promptPayload } = params;
    if (this.active.has(sessionID)) {
      return { ok: false, reason: 'busy' };
    }

    const agyBin = resolveAgyBinary(this.env);
    const assistantMessageID = `msg_${Date.now()}_${++this.seq}`;
    const translator = new AgyTurnTranslator({
      sessionID,
      assistantMessageID,
      modelID,
      agent,
      directory,
      emit: (ev) => this.sseHub.broadcast(ev),
      onConversationId: (convId) => this.store.setAgyConversationId(sessionID, convId),
    });

    if (!agyBin) {
      translator.begin();
      const msg = translator.fail('agy executable not found on this machine');
      if (msg) this.store.upsertMessage(sessionID, msg);
      return { ok: true };
    }

    const magpie = loadMagpieAgyEnv({ env: this.env });
    const childEnv = { ...this.env, ...magpie.envPatch };
    const sessionState = this.store.getSession(sessionID);
    const promptText = this.buildPromptText(promptPayload);

    const args = [];
    if (magpie.settingsPath) {
      args.push('--settings', magpie.settingsPath);
    }
    args.push('--output-format', 'stream-json');
    if (modelID) {
      args.push('--model', modelID);
    }
    if (sessionState?.agyConversationId) {
      args.push('--conversation', sessionState.agyConversationId);
    }
    if (this.env.AGY_ROUTER_AGY_AUTO_APPROVE !== '0') {
      args.push('--dangerously-skip-permissions');
    }
    args.push('-p', promptText);

    const cwd = directory && fs.existsSync(directory) ? directory : process.cwd();
    const spec = buildSpawnSpec(agyBin, args);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry = { child, interrupted: false };
    this.active.set(sessionID, entry);
    translator.begin();

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          translator.handleLine(parsed);
        } catch {
          // Ignore non-JSON preamble lines
        }
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrBuf = (stderrBuf + chunk.toString()).slice(-4096);
    });

    const finalize = (code) => {
      this.active.delete(sessionID);
      if (stdoutBuf.trim()) {
        try {
          translator.handleLine(JSON.parse(stdoutBuf.trim()));
        } catch {}
      }

      let assistantMsg;
      if (entry.interrupted) {
        assistantMsg = translator.interrupt('user');
      } else if (!translator.finished) {
        if (code === 0) {
          assistantMsg = translator.complete();
        } else {
          assistantMsg = translator.fail(stderrBuf.trim() || `agy-cli exited with code ${code}`);
        }
      } else {
        assistantMsg = translator.toAssistantMessage(code === 0 ? 'stop' : 'error');
      }

      if (assistantMsg) {
        this.store.upsertMessage(sessionID, assistantMsg);
      }
    };

    child.on('close', (code) => finalize(code));
    child.on('error', (err) => {
      this.active.delete(sessionID);
      const msg = translator.fail(err?.message || String(err));
      if (msg) this.store.upsertMessage(sessionID, msg);
    });

    return { ok: true };
  }

  /**
   * Interrupt an active `agy-cli` turn for `sessionID`.
   * @param {string} sessionID
   */
  interrupt(sessionID) {
    const entry = this.active.get(sessionID);
    if (!entry) return false;
    entry.interrupted = true;
    try {
      if (IS_WIN && entry.child.pid) {
        spawnSync('taskkill', ['/pid', String(entry.child.pid), '/f', '/t'], { windowsHide: true });
      } else {
        entry.child.kill('SIGTERM');
      }
    } catch {
      // Ignore kill errors
    }
    return true;
  }

  stopAll() {
    for (const id of [...this.active.keys()]) {
      this.interrupt(id);
    }
  }
}
