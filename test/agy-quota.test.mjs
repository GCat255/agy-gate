import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOAuthManager, extractCodeFromManualInput } from '../extensions/agy-quota/service/oauth.js';
import { transformQuotaPayloads } from '../extensions/agy-quota/service/quota.js';
import { startService } from '../extensions/agy-quota/service/main.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'extensions', 'agy-quota');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-quota-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('agy-quota extension package & manifest', () => {
  it('declares headless OpenChamber quota manifest without sidebar panel UI', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(EXT_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.openchamber.apiVersion, 1);
    assert.equal(pkg.openchamber.contributes.panel.id, 'agy-quota');
    assert.equal(pkg.openchamber.contributes.panel.icon, 'panel/icon.svg');
    assert.equal(pkg.openchamber.contributes.panel.entry, undefined);
    assert.deepEqual(pkg.openchamber.contributes.service, {
      entry: 'service/main.js',
      runtime: 'host',
      provides: ['quota'],
    });
    assert.deepEqual(pkg.openchamber.contributes.quota, { providers: [] });

    await fs.access(path.join(EXT_DIR, 'panel', 'icon.svg'));
    await assert.rejects(fs.access(path.join(EXT_DIR, 'panel', 'index.html')));
  });
});

describe('agy-quota OAuth & token management', () => {
  it('supports loopback OAuth callback, token caching, and forced refresh', async () => {
    await withTempDir(async (dir) => {
      const authFile = path.join(dir, 'quota-auth.json');
      let tokenCalls = 0;
      const mockFetch = async (url, init) => {
        if (String(url).includes('oauth2.googleapis.com/token')) {
          tokenCalls++;
          const params = new URLSearchParams(String(init.body));
          if (params.get('grant_type') === 'authorization_code') {
            return new Response(
              JSON.stringify({
                access_token: 'access-initial',
                refresh_token: 'refresh-secret-1',
                expires_in: 3600,
              }),
              { status: 200 },
            );
          }
          if (params.get('grant_type') === 'refresh_token') {
            return new Response(
              JSON.stringify({
                access_token: 'access-refreshed',
                expires_in: 3600,
              }),
              { status: 200 },
            );
          }
        }
        if (String(url).includes('googleapis.com/oauth2/v2/userinfo')) {
          return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      };

      const oauth = createOAuthManager({
        authFilePath: authFile,
        fetchImpl: mockFetch,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
      const started = await oauth.startLogin();
      assert.equal(started.connected, false);
      assert.ok(started.pendingAuth.authUrl.includes('https://accounts.google.com/o/oauth2/v2/auth'));
      const redirectUri = started.pendingAuth.redirectUri;
      const state = new URL(started.pendingAuth.authUrl).searchParams.get('state');

      const [record, callbackRes] = await Promise.all([
        oauth.waitForCompletion(),
        fetch(`${redirectUri}?code=auth-code-123&state=${encodeURIComponent(state)}`),
      ]);
      assert.equal(record.email, 'user@example.com');
      assert.equal(callbackRes.status, 200);
      const callbackHtml = await callbackRes.text();
      assert.ok(callbackHtml.includes('Google 授权成功'));

      const status = await oauth.getStatus();
      assert.equal(status.connected, true);
      assert.equal(status.email, 'user@example.com');
      assert.equal(status.pendingAuth, null);

      const firstToken = await oauth.getAccessToken();
      assert.equal(firstToken.accessToken, 'access-initial');
      assert.equal(tokenCalls, 1);

      const forcedToken = await oauth.getAccessToken({ forceRefresh: true });
      assert.equal(forcedToken.accessToken, 'access-refreshed');
      assert.equal(tokenCalls, 2);

      await oauth.clearAuth();
      const cleared = await oauth.getStatus();
      assert.equal(cleared.connected, false);
      await oauth.close();
    });
  });

  it('extracts code and validates state from manual callback URL or raw code', () => {
    const code = extractCodeFromManualInput(
      'http://127.0.0.1:45678/oauth-callback?state=st-ok&code=manual-999',
      'st-ok',
    );
    assert.equal(code, 'manual-999');
    assert.equal(extractCodeFromManualInput('raw-code-1', 'st-ok'), 'raw-code-1');
    assert.throws(
      () => extractCodeFromManualInput('http://127.0.0.1:45678/oauth-callback?state=wrong&code=x', 'st-ok'),
      /state/,
    );
  });

  it('does not embed literal OAuth client secrets in source and resolves from AGY_ROUTER_AGY_BIN by fingerprint', async () => {
    const src = await fs.readFile(path.join(EXT_DIR, 'service', 'oauth.js'), 'utf8');
    assert.equal(/GOCSPX-[0-9A-Za-z_-]{20,}/.test(src), false, 'oauth.js source must not contain literal clientSecret');

    await withTempDir(async (dir) => {
      const fakeBin = path.join(dir, 'mock-agy-bin.exe');
      const fakeSecret = 'GOCSPX-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
      const expectedSha256 = crypto.createHash('sha256').update(fakeSecret).digest('hex');
      await fs.writeFile(fakeBin, Buffer.from(`padding\0${fakeSecret}\0more`, 'latin1'));

      let seenSecret = null;
      const oauth = createOAuthManager({
        authFilePath: path.join(dir, 'quota-auth.json'),
        env: { AGY_ROUTER_AGY_BIN: fakeBin },
        clientSecretSha256: expectedSha256,
        fetchImpl: async (url, init) => {
          if (String(url).includes('oauth2.googleapis.com/token')) {
            seenSecret = new URLSearchParams(String(init.body)).get('client_secret');
            return new Response(
              JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ email: 'mock@example.com' }), { status: 200 });
        },
      });
      const started = await oauth.startLogin();
      const state = new URL(started.pendingAuth.authUrl).searchParams.get('state');
      const [rec] = await Promise.all([
        oauth.waitForCompletion(),
        fetch(`${started.pendingAuth.redirectUri}?code=c1&state=${encodeURIComponent(state)}`),
      ]);
      assert.equal(seenSecret, fakeSecret);
      assert.equal(rec.email, 'mock@example.com');
      await oauth.close();
    });
  });

  it('dynamically detects quota-auth.json written after manager startup', async () => {
    await withTempDir(async (dir) => {
      const dataDir = path.join(dir, 'agy-gate-data');
      const oauth = createOAuthManager({
        env: { AGY_GATE_DATA_DIR: dataDir },
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
      const initial = await oauth.getStatus();
      assert.equal(initial.connected, false);

      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(
        path.join(dataDir, 'quota-auth.json'),
        JSON.stringify({
          email: 'late@example.com',
          accessToken: 'late-access-token',
          refreshToken: 'late-refresh-token',
          expiresAt: Date.now() + 3_600_000,
        }),
        'utf8',
      );

      const after = await oauth.getStatus();
      assert.equal(after.connected, true);
      assert.equal(after.email, 'late@example.com');
      const token = await oauth.getAccessToken();
      assert.equal(token?.accessToken, 'late-access-token');
      await oauth.close();
    });
  });
});

describe('agy-quota payload transformation & HTTP service', () => {
  it('returns only concise pool windows without duplicate per-model rows', () => {
    const out = transformQuotaPayloads({
      planLabel: 'Google AI Ultra',
      summaryPayload: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { window: '5h', remainingFraction: 0.75, resetTime: '2026-11-21T15:00:00Z' },
              { window: 'weekly', remainingFraction: 0.4, resetTime: '2026-11-26T00:00:00Z' },
            ],
          },
          {
            displayName: 'Claude / Third-Party Models',
            buckets: [
              { window: '5h', remainingFraction: 0.9, resetTime: '2026-11-21T14:00:00Z' },
              { window: 'weekly', remainingFraction: 0.65, resetTime: '2026-11-27T00:00:00Z' },
            ],
          },
        ],
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.configured, true);
    assert.equal(out.planLabel, 'Google AI Ultra');
    assert.deepEqual(Object.keys(out.usage.windows), [
      'Gemini (5h)',
      'Gemini (Weekly)',
      'Claude / GPT (5h)',
      'Claude / GPT (Weekly)',
    ]);
    assert.equal(out.usage.windows['Gemini (5h)'].usedPercent, 25);
    assert.equal(out.usage.windows['Gemini (5h)'].windowSeconds, 18000);
    assert.equal(out.usage.windows['Gemini (Weekly)'].usedPercent, 60);
    assert.equal(out.usage.windows['Gemini (Weekly)'].windowSeconds, 604800);
    assert.equal(out.usage.windows['Claude / GPT (5h)'].usedPercent, 10);
    assert.equal(out.usage.windows['Claude / GPT (Weekly)'].usedPercent, 35);
    assert.equal(out.usage.models, undefined);
  });

  it('falls back to aggregated Gemini and Claude / GPT buckets when summary groups are empty', () => {
    const out = transformQuotaPayloads({
      summaryPayload: { groups: [] },
      modelsPayload: {
        models: {
          'gemini-4-neon': { quotaInfo: { remainingFraction: 0.8 } },
          'gemini-4-carbon': { quotaInfo: { remainingFraction: 0.6 } },
          'claude-opus-5-5': { quotaInfo: { remainingFraction: 0.9 } },
          'gpt-oss-120b': { quotaInfo: { remainingFraction: 0.7 } },
        },
      },
    });
    assert.deepEqual(Object.keys(out.usage.windows), ['Gemini', 'Claude / GPT']);
    assert.equal(out.usage.windows.Gemini.usedPercent, 40);
    assert.equal(out.usage.windows['Claude / GPT'].usedPercent, 30);
    assert.equal(out.usage.models, undefined);
  });

  it('serves /health and /quota (unconfigured & configured) without calling fetchAvailableModels when summary succeeds', async () => {
    await withTempDir(async (dir) => {
      const authFile = path.join(dir, 'quota-auth.json');
      let modelsEndpointCalled = false;
      const mockFetch = async (url) => {
        const u = String(url);
        if (u.includes(':loadCodeAssist')) {
          return new Response(JSON.stringify({
            cloudaicompanionProject: 'proj-abc',
            paidTier: { name: 'Gemini Code Assist Standard' },
          }), { status: 200 });
        }
        if (u.includes(':retrieveUserQuotaSummary')) {
          return new Response(JSON.stringify({
            groups: [
              { displayName: 'Gemini', buckets: [{ window: '5h', remainingFraction: 0.8, resetTime: 1795266000 }] },
            ],
          }), { status: 200 });
        }
        if (u.includes(':fetchAvailableModels')) {
          modelsEndpointCalled = true;
          return new Response('{}', { status: 200 });
        }
        return new Response('{}', { status: 404 });
      };

      const { server } = await startService({
        port: 0,
        serviceToken: 'test-secret-token',
        authFilePath: authFile,
        fetchImpl: mockFetch,
      });

      try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const health = await fetch(`${baseUrl}/health`);
        assert.equal(health.status, 200);

        const unauth = await fetch(`${baseUrl}/quota`, { method: 'POST' });
        assert.equal(unauth.status, 401);

        const authHeaders = {
          Authorization: 'Bearer test-secret-token',
          'Content-Type': 'application/json',
        };
        const unconfigured = await fetch(`${baseUrl}/quota`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ v: 1, capability: 'quota', method: 'usage.read', input: { providerId: 'ext-agy-quota' } }),
        });
        assert.equal(unconfigured.status, 200);
        const unconfJson = await unconfigured.json();
        assert.equal(unconfJson.ok, true);
        assert.equal(unconfJson.data.configured, true);
        assert.equal(unconfJson.data.ok, false);
        assert.match(unconfJson.data.error, /occ|quota-login/);

        await fs.writeFile(authFile, JSON.stringify({
          email: 'demo@example.com',
          accessToken: 'live-access-token',
          refreshToken: 'live-refresh-token',
          expiresAt: Date.now() + 3_600_000,
        }), 'utf8');

        const configured = await fetch(`${baseUrl}/quota`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ v: 1, capability: 'quota', method: 'usage.read', input: { providerId: 'ext-agy-quota' } }),
        });
        assert.equal(configured.status, 200);
        const confJson = await configured.json();
        assert.equal(confJson.ok, true);
        assert.equal(confJson.data.ok, true);
        assert.equal(confJson.data.configured, true);
        assert.equal(confJson.data.planLabel, 'Gemini Code Assist Standard');
        assert.equal(confJson.data.usage.windows['Gemini (5h)'].usedPercent, 20);
        assert.equal(confJson.data.usage.windows['Gemini (5h)'].resetAt, 1795266000 * 1000);
        assert.equal(confJson.data.usage.models, undefined);
        assert.equal(modelsEndpointCalled, false);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
