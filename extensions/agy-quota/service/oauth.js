import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const ANTIGRAVITY_OAUTH_CLIENT = Object.freeze({
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: process.env.AGY_QUOTA_OAUTH_CLIENT_SECRET || '',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
});

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveDefaultAuthFilePath(env = process.env) {
  if (env.AGY_QUOTA_AUTH_FILE?.trim()) {
    return path.resolve(env.AGY_QUOTA_AUTH_FILE.trim());
  }
  const primary = path.join(os.homedir(), '.config', 'agy-gate', 'quota-auth.json');
  if (fsSync.existsSync(primary)) return primary;
  const legacy = path.join(os.homedir(), '.config', 'agy-opencode-router', 'quota-auth.json');
  if (fsSync.existsSync(legacy)) return legacy;
  return primary;
}

function resolveFallbackAuthFilePath(env = process.env) {
  if (env.AGY_QUOTA_AUTH_FILE?.trim() || !env.OPENCHAMBER_SERVICE_DATA_DIR?.trim()) {
    return null;
  }
  return path.join(path.resolve(env.OPENCHAMBER_SERVICE_DATA_DIR.trim()), 'quota-auth.json');
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderCallbackPage({ ok, title, detail }) {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #eef1f5; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      .box { max-width: 440px; padding: 24px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: #171a21; }
      h1 { margin: 0 0 8px; font-size: 18px; color: ${color}; }
      p { margin: 0; color: #9aa4b2; font-size: 14px; line-height: 1.6; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
    </div>
  </body>
</html>`;
}

export function extractCodeFromManualInput(rawInput, expectedState) {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) {
    throw new Error('请输入回调 URL 或授权码。');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    const err = parsed.searchParams.get('error');
    if (err) {
      throw new Error(`Google 授权被拒绝：${err}`);
    }
    const state = parsed.searchParams.get('state');
    if (expectedState && state && state !== expectedState) {
      throw new Error('授权 state 不匹配，请重新发起登录。');
    }
    const code = parsed.searchParams.get('code');
    if (!code) {
      throw new Error('回调 URL 中未包含授权码 code。');
    }
    return code;
  }
  return trimmed;
}

export function createOAuthManager(options = {}) {
  const authFilePath = options.authFilePath ?? resolveDefaultAuthFilePath(options.env);
  const fallbackAuthFilePath = options.authFilePath ? null : resolveFallbackAuthFilePath(options.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientId = options.clientId ?? ANTIGRAVITY_OAUTH_CLIENT.clientId;
  const clientSecret = options.clientSecret ?? ANTIGRAVITY_OAUTH_CLIENT.clientSecret;

  let activeFlow = null;
  let refreshPromise = null;
  let lastError = null;

  async function readJsonIfExists(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async function readAuth() {
    const primary = await readJsonIfExists(authFilePath);
    if (primary) return primary;
    if (fallbackAuthFilePath && fallbackAuthFilePath !== authFilePath) {
      return readJsonIfExists(fallbackAuthFilePath);
    }
    return null;
  }

  async function writeAuth(next) {
    const dir = path.dirname(authFilePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${authFilePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, authFilePath);
    try {
      await fs.chmod(authFilePath, 0o600);
    } catch {
      // Ignore chmod limitations on Windows filesystems.
    }
    return next;
  }

  async function clearAuth() {
    lastError = null;
    for (const target of [authFilePath, fallbackAuthFilePath]) {
      if (!target) continue;
      try {
        await fs.unlink(target);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  async function closeActiveFlow() {
    const flow = activeFlow;
    activeFlow = null;
    if (!flow) return;
    clearTimeout(flow.timer);
    await new Promise((resolve) => {
      try {
        flow.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async function fetchUserEmail(accessToken) {
    try {
      const res = await fetchImpl(ANTIGRAVITY_OAUTH_CLIENT.userInfoUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!res.ok) return null;
      const payload = await res.json();
      return typeof payload?.email === 'string' && payload.email.trim() ? payload.email.trim() : null;
    } catch {
      return null;
    }
  }

  async function exchangeCode({ code, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const res = await fetchImpl(ANTIGRAVITY_OAUTH_CLIENT.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!res.ok || !payload?.access_token) {
      const msg = payload?.error_description || payload?.error || `HTTP ${res.status}`;
      throw new Error(`Google 令牌交换失败：${msg}`);
    }
    const existing = await readAuth();
    const refreshToken = payload.refresh_token || existing?.refreshToken;
    if (!refreshToken) {
      throw new Error('Google 未返回 refresh_token，请重试授权并在提示页勾选授权。');
    }
    const expiresInSec = Number(payload.expires_in) || 3600;
    const email = (await fetchUserEmail(payload.access_token)) || existing?.email || null;
    const record = {
      email,
      projectId: existing?.projectId || null,
      planLabel: existing?.planLabel || null,
      accessToken: payload.access_token,
      refreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
      updatedAt: new Date().toISOString(),
    };
    await writeAuth(record);
    lastError = null;
    return record;
  }

  async function startLogin() {
    await closeActiveFlow();
    lastError = null;

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');

    let resolveDone;
    let rejectDone;
    const completed = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/oauth-callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const err = reqUrl.searchParams.get('error');
        if (err) {
          lastError = `Google 授权未完成：${err}`;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderCallbackPage({ ok: false, title: '授权未完成', detail: lastError }));
          rejectDone(new Error(lastError));
          void closeActiveFlow();
          return;
        }
        const returnedState = reqUrl.searchParams.get('state');
        if (!returnedState || returnedState !== state) {
          lastError = '授权 state 校验失败，请重试。';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderCallbackPage({ ok: false, title: '校验失败', detail: lastError }));
          return;
        }
        const code = reqUrl.searchParams.get('code');
        if (!code) {
          lastError = '回调缺少授权码 code。';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderCallbackPage({ ok: false, title: '参数缺失', detail: lastError }));
          return;
        }

        const redirectUri = activeFlow?.redirectUri || `http://127.0.0.1:${server.address().port}/oauth-callback`;
        const record = await exchangeCode({ code, redirectUri, codeVerifier });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackPage({
          ok: true,
          title: 'Google 授权成功',
          detail: `已连接账号 ${record.email || 'Google 账号'}，现在可以关闭此标签页并返回 OpenChamber。`,
        }));
        resolveDone(record);
        void closeActiveFlow();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackPage({ ok: false, title: '登录失败', detail: lastError }));
        rejectDone(error);
        void closeActiveFlow();
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth-callback`;
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: ANTIGRAVITY_OAUTH_CLIENT.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    const authUrl = `${ANTIGRAVITY_OAUTH_CLIENT.authorizeUrl}?${authParams.toString()}`;
    const timer = setTimeout(() => {
      rejectDone(new Error('等待 Google 授权超时，请重试。'));
      void closeActiveFlow();
    }, AUTH_FLOW_TIMEOUT_MS);
    timer.unref?.();

    activeFlow = {
      server,
      state,
      codeVerifier,
      redirectUri,
      authUrl,
      startedAt: Date.now(),
      timer,
      completed,
    };

    return getStatus();
  }

  function waitForCompletion() {
    if (!activeFlow) {
      return Promise.reject(new Error('当前没有进行中的登录会话。'));
    }
    return activeFlow.completed;
  }

  async function completeManualCallback(rawInput) {
    if (!activeFlow) {
      throw new Error('请先发起一次授权，再粘贴回调结果。');
    }
    const flow = activeFlow;
    const code = extractCodeFromManualInput(rawInput, flow.state);
    const record = await exchangeCode({
      code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
    });
    await closeActiveFlow();
    return record;
  }

  async function refreshAccessToken(auth) {
    if (!auth?.refreshToken) {
      throw new Error('尚未登录 Google 账号。');
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetchImpl(ANTIGRAVITY_OAUTH_CLIENT.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!res.ok || !payload?.access_token) {
      const code = payload?.error || '';
      const desc = payload?.error_description || code || `HTTP ${res.status}`;
      if (code === 'invalid_grant') {
        lastError = 'Google OAuth 授权已过期或被撤销，请重新运行 agy-gate quota-login 授权。';
        throw new Error(lastError);
      }
      throw new Error(`刷新 Google 访问令牌失败：${desc}`);
    }
    const expiresInSec = Number(payload.expires_in) || 3600;
    const latest = (await readAuth()) || auth;
    const next = {
      ...latest,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || latest.refreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
      updatedAt: new Date().toISOString(),
    };
    await writeAuth(next);
    lastError = null;
    return next;
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    const auth = await readAuth();
    if (!auth?.refreshToken) {
      return null;
    }
    if (
      !forceRefresh
      && auth.accessToken
      && typeof auth.expiresAt === 'number'
      && auth.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS
    ) {
      return { accessToken: auth.accessToken, auth };
    }
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(auth).finally(() => {
        refreshPromise = null;
      });
    }
    const updated = await refreshPromise;
    return { accessToken: updated.accessToken, auth: updated };
  }

  async function updateMetadata(patch) {
    const auth = await readAuth();
    if (!auth) return null;
    const next = {
      ...auth,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return writeAuth(next);
  }

  async function getStatus() {
    const auth = await readAuth();
    return {
      connected: Boolean(auth?.refreshToken),
      email: auth?.email ?? null,
      planLabel: auth?.planLabel ?? null,
      projectId: auth?.projectId ?? null,
      expiresAt: typeof auth?.expiresAt === 'number' ? auth.expiresAt : null,
      authFilePath,
      pendingAuth: activeFlow
        ? {
            authUrl: activeFlow.authUrl,
            redirectUri: activeFlow.redirectUri,
            startedAt: activeFlow.startedAt,
          }
        : null,
      lastError,
    };
  }

  return {
    authFilePath,
    readAuth,
    clearAuth,
    startLogin,
    waitForCompletion,
    completeManualCallback,
    getAccessToken,
    updateMetadata,
    getStatus,
    close: closeActiveFlow,
  };
}
