import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildSpawnSpec } from '../core/process.mjs';

export { buildSpawnSpec };

/**
 * Reserve an unused ephemeral TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
export function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Synchronously run `<realOpenCode> --version`.
 * @param {string} binary
 */
export function readRealOpenCodeVersion(binary) {
  const spec = buildSpawnSpec(binary, ['--version']);
  return spawnSync(spec.command, spec.args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: process.env,
  });
}

/**
 * Build Basic Auth header matching `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildUpstreamAuthHeader(env = process.env) {
  const password = env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD || '';
  if (!password) return null;
  const token = Buffer.from(`opencode:${password}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Spawn and supervise the internal real `opencode serve` process.
 * @param {{ binary: string, hostname?: string, port?: number, stdio?: boolean, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 */
export async function startInternalOpenCode(options) {
  const hostname = options.hostname || '127.0.0.1';
  const port = options.port || (await allocateLoopbackPort());
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs || 30_000;
  const useStdio = options.stdio ?? IS_WIN;

  const ocArgs = ['serve', ...(useStdio ? ['--stdio'] : []), '--hostname', hostname, '--port', String(port)];
  const spec = buildSpawnSpec(options.binary, ocArgs);

  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    detached: false,
    stdio: [useStdio ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  child.stdin?.on('error', () => {});

  const baseUrl = `http://${hostname}:${port}`;
  let stderrTail = '';
  let exited = false;

  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
  });

  const readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuf = '';

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      fn(val);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for internal opencode serve (${timeoutMs}ms). ${stderrTail}`));
    }, timeoutMs);

    const authHeader = buildUpstreamAuthHeader(env);
    const probeInfo = async () => {
      if (settled || exited) return;
      try {
        const res = await fetch(`${baseUrl}/api/info`, {
          headers: authHeader ? { Authorization: authHeader } : undefined,
        });
        if (res.ok) {
          finish(resolve, { baseUrl, port });
        }
      } catch {
        // Keep waiting
      }
    };

    const poller = setInterval(() => {
      void probeInfo();
    }, 200);

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      if (/server listening on\s+https?:\/\/\S+/i.test(stdoutBuf) || /"url"\s*:\s*"https?:\/\/[^"]+"/i.test(stdoutBuf)) {
        void probeInfo();
      }
    });

    child.on('exit', (code, signal) => {
      exited = true;
      finish(
        reject,
        new Error(`Internal opencode serve exited prematurely (code=${code}, signal=${signal}): ${stderrTail}`),
      );
    });

    child.on('error', (err) => {
      exited = true;
      finish(reject, err);
    });
  });

  await readyPromise;

  const stop = async () => {
    if (exited) return;
    try {
      if (useStdio && child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    } catch {
      // Ignore
    }
    const waitExit = new Promise((resolve) => {
      if (exited) return resolve();
      const t = setTimeout(resolve, 4000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    await waitExit;
    if (!exited) {
      if (IS_WIN && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
      } else {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    }
  };

  return {
    baseUrl,
    port,
    child,
    stop,
    isRunning: () => !exited,
  };
}
