import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOAuthManager } from './oauth.js';
import { readAntigravityQuota } from './quota.js';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Request body exceeds limit');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

export function createServiceApp(options = {}) {
  const expectedToken = options.serviceToken ?? process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
  const oauthManager = options.oauthManager ?? createOAuthManager(options);

  const handler = async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

      if (reqUrl.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (expectedToken) {
        const authHeader = req.headers.authorization || '';
        if (authHeader !== `Bearer ${expectedToken}`) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }
      }

      if (req.method === 'POST' && reqUrl.pathname === '/quota') {
        try {
          await readJsonBody(req).catch(() => ({}));
          const data = await readAntigravityQuota(oauthManager, options);
          sendJson(res, 200, { ok: true, data });
        } catch (err) {
          const raw = (err instanceof Error ? err.message : String(err ?? '')).trim() || '读取 Antigravity 用量失败';
          const message = raw.length > 400 ? `${raw.slice(0, 397)}...` : raw;
          sendJson(res, 200, { ok: false, error: { message } });
        }
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/auth/status') {
        const status = await oauthManager.getStatus();
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/auth/start') {
        const status = await oauthManager.startLogin();
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/auth/manual') {
        const body = await readJsonBody(req);
        await oauthManager.completeManualCallback(body?.input);
        const status = await oauthManager.getStatus();
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/auth/logout') {
        await oauthManager.clearAuth();
        const status = await oauthManager.getStatus();
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/quota/preview') {
        const [status, quota] = await Promise.all([
          oauthManager.getStatus(),
          readAntigravityQuota(oauthManager, options),
        ]);
        sendJson(res, 200, {
          ...quota,
          email: status.email,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
  };

  return { handler, oauthManager };
}

export async function startService(options = {}) {
  const port = Number(options.port ?? process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
  const { handler, oauthManager } = createServiceApp(options);
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, oauthManager };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN || '';
  if (!port || !token) {
    console.error('Missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN');
    process.exit(1);
  }
  const { server, oauthManager } = await startService({ port, serviceToken: token });
  const shutdown = async () => {
    await oauthManager.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}
