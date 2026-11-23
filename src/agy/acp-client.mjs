import { spawn, spawnSync } from 'node:child_process';
import { buildSpawnSpec } from '../core/process.mjs';

const IS_WIN = process.platform === 'win32';

/**
 * Terminate a child process tree cleanly on Windows/POSIX.
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 */
export function killChildProcessTree(child) {
  if (!child) return;
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
 * Pick an allow/approve outcome when an ACP server sends `session/request_permission`.
 * @param {any} params
 */
export function buildDefaultPermissionAllowResult(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const allowOpt =
    options.find((o) => o && typeof o.optionId === 'string' && /allow_once|allow/i.test(`${o.kind || ''} ${o.optionId}`))
    || options.find((o) => o && typeof o.optionId === 'string' && !/reject|deny|cancel/i.test(`${o.kind || ''} ${o.optionId}`));
  if (allowOpt) {
    return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Pick a safe rejection/cancellation outcome when an ACP server sends `session/request_permission`.
 * @param {any} params
 */
export function buildDefaultPermissionRejectResult(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const rejectOpt = options.find((o) =>
    o && typeof o.optionId === 'string' && /reject|deny|cancel/i.test(`${o.kind || ''} ${o.optionId}`),
  );
  if (rejectOpt) {
    return { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Minimal stdio NDJSON JSON-RPC 2.0 client for `agy acp`.
 */
export class AgyAcpClient {
  /**
   * @param {{
   *   agyBin: string,
   *   args: string[],
   *   cwd: string,
   *   env: NodeJS.ProcessEnv,
   *   onPermissionRequest?: (params: any) => any,
   *   onNotification?: (method: string, params: any) => void,
   *   onClose?: (info: { code: number | null, stderr: string }) => void,
   * }} options
   */
  constructor(options) {
    const spec = buildSpawnSpec(options.agyBin, options.args);
    this.child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.onPermissionRequest = options.onPermissionRequest || null;
    this.onNotification = options.onNotification || null;
    this.onClose = options.onClose || null;
    this.nextId = 1;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.exited = false;
    this.closedIntentionally = false;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout | null }>} */
    this.pending = new Map();

    this.child.stdin?.on('error', () => {});

    this.child.stdout?.on('data', (chunk) => {
      this.stdoutBuf += chunk.toString();
      const lines = this.stdoutBuf.split(/\r?\n/);
      this.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        this._handleLine(line);
      }
    });

    this.child.stderr?.on('data', (chunk) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString()).slice(-4096);
    });

    this.child.on('close', (code) => {
      this.exited = true;
      if (this.stdoutBuf.trim()) {
        this._handleLine(this.stdoutBuf);
        this.stdoutBuf = '';
      }
      const errMsg = this.stderrBuf.trim() || `agy acp exited with code ${code}`;
      this._rejectAllPending(new Error(errMsg));
      if (this.onClose) {
        this.onClose({ code, stderr: this.stderrBuf });
      }
    });

    this.child.on('error', (err) => {
      this.exited = true;
      const errObj = err instanceof Error ? err : new Error(String(err));
      this._rejectAllPending(errObj);
      if (this.onClose) {
        this.onClose({ code: null, stderr: errObj.message });
      }
    });
  }

  _rejectAllPending(error) {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  _writeJson(payload) {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('agy acp stdin is closed');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Response to an outbound request
    if (Object.hasOwn(msg, 'id') && !msg.method) {
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error?.message || `ACP error ${msg.error?.code ?? ''}`.trim());
        err.code = msg.error?.code;
        err.data = msg.error?.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Inbound server request (requires JSON-RPC response)
    if (Object.hasOwn(msg, 'id') && typeof msg.method === 'string') {
      try {
        if (msg.method === 'session/request_permission') {
          const permResult = this.onPermissionRequest
            ? this.onPermissionRequest(msg.params)
            : buildDefaultPermissionRejectResult(msg.params);
          this._writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            result: permResult || buildDefaultPermissionRejectResult(msg.params),
          });
        } else {
          this._writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Method not implemented by agy-gate: ${msg.method}` },
          });
        }
      } catch {
        // Ignore write errors on closing stream
      }
      return;
    }

    // Inbound notification (e.g. session/update)
    if (typeof msg.method === 'string' && this.onNotification) {
      this.onNotification(msg.method, msg.params);
    }
  }

  /**
   * Send a JSON-RPC request and await its result.
   * @param {string} method
   * @param {any} params
   * @param {number} [timeoutMs]
   */
  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new Error(`ACP request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._writeJson({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a JSON-RPC notification without waiting for a response.
   * @param {string} method
   * @param {any} params
   */
  notify(method, params) {
    try {
      this._writeJson({ jsonrpc: '2.0', method, params });
    } catch {
      // Ignore notification errors when transport is closing
    }
  }

  /**
   * Close stdin gracefully or terminate the ACP process tree immediately.
   * @param {boolean} [forceKill]
   */
  close(forceKill = false) {
    this.closedIntentionally = true;
    if (this.exited) return;
    if (!forceKill) {
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.end();
          return;
        }
      } catch {
        // Fall through to process tree termination
      }
    }
    killChildProcessTree(this.child);
  }
}
