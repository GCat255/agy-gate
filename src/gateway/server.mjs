import http from 'node:http';
import { AGY_PROVIDER_ID, getAgyCatalog } from '../agy/models.mjs';
import { isAgyChildSessionID } from '../agy/subagent-bridge.mjs';
import {
  buildUpstreamCompactionPrompt,
  extractUpstreamOnlyMessages,
  formatMessagesAsHandoverContext,
} from './context-bridge.mjs';
import { normalizePromptFiles } from './store.mjs';

/**
 * Read full request body as Buffer.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Send JSON response with status code.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Resolve directory from `x-opencode-directory` header or query param.
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 */
function requestDirectory(req, url) {
  const raw = req.headers['x-opencode-directory'] || url.searchParams.get('directory');
  if (Array.isArray(raw)) return raw[0] || null;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return decodeURIComponent(raw.trim());
    } catch {
      return raw.trim();
    }
  }
  return null;
}

/**
 * Forward an HTTP request to the internal OpenCode server and buffer JSON when rewriting is needed.
 * @param {{ upstreamBase: string, authHeader: string | null, req: import('node:http').IncomingMessage, method: string, pathAndQuery: string, body?: Buffer | null }} opts
 */
async function fetchUpstream(opts) {
  const headers = {};
  for (const [key, value] of Object.entries(opts.req.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding') {
      continue;
    }
    if (value !== undefined) headers[key] = value;
  }
  if (opts.authHeader) headers.authorization = opts.authHeader;

  const init = {
    method: opts.method,
    headers,
  };
  if (opts.body && opts.body.length > 0 && opts.method !== 'GET' && opts.method !== 'HEAD') {
    init.body = opts.body;
  }

  return fetch(`${opts.upstreamBase}${opts.pathAndQuery}`, init);
}

/**
 * Create the OpenCode-compatible HTTP routing gateway server.
 * @param {{
 *   upstreamBase: () => string,
 *   authHeader: () => string | null,
 *   clientAuthHeader?: () => string | null,
 *   store: import('./store.mjs').RouterStore,
 *   sseHub: import('./sse-hub.mjs').SseHub,
 *   agyRunner: import('./agy-runner.mjs').AgyRunner,
 *   getAgyCatalogFn?: typeof getAgyCatalog,
 * }} deps
 */
export function createRouterServer(deps) {
  const loadCatalog = deps.getAgyCatalogFn || getAgyCatalog;
  const getClientAuth = deps.clientAuthHeader || deps.authHeader;

  async function fetchAllUpstreamMessagesResult(sessionID, req, expectedAuth, options = {}) {
    const pageLimit = 200;
    const seenCursors = new Set();
    const collected = [];
    let cursor = null;

    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams({ limit: String(pageLimit) });
      if (options.type) params.set('type', options.type);
      if (cursor) params.set('cursor', cursor);

      const up = await fetchUpstream({
        upstreamBase: deps.upstreamBase(),
        authHeader: expectedAuth,
        req,
        method: 'GET',
        pathAndQuery: `/api/session/${encodeURIComponent(sessionID)}/message?${params.toString()}`,
      });
      const text = await up.text();
      if (!up.ok) {
        if (page === 0) {
          return {
            ok: false,
            status: up.status,
            contentType: up.headers.get('content-type') || 'application/json',
            text,
          };
        }
        break;
      }

      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        if (page === 0) {
          return {
            ok: false,
            status: 502,
            contentType: 'application/json',
            text: JSON.stringify({ error: 'Invalid JSON from upstream message list' }),
          };
        }
        break;
      }

      const items = Array.isArray(json?.data) ? json.data : [];
      collected.push(...items);

      const nextCursor = typeof json?.cursor?.next === 'string' && json.cursor.next ? json.cursor.next : null;
      if (!nextCursor || items.length < pageLimit || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return { ok: true, messages: collected };
  }

  async function fetchUpstreamMessages(sessionID, req, expectedAuth) {
    try {
      const result = await fetchAllUpstreamMessagesResult(sessionID, req, expectedAuth);
      return result.ok ? result.messages : [];
    } catch {
      return [];
    }
  }

  async function prepareAgyHandoverContext(sessionID, req, expectedAuth) {
    const sessionState = deps.store.getSession(sessionID);
    if (sessionState?.agyConversationId && !sessionState?.needsUpstreamSync) {
      return { handoverContext: null, upstreamMessageIds: [] };
    }
    const upstreamList = await fetchUpstreamMessages(sessionID, req, expectedAuth);
    const localList = deps.store.getMessages(sessionID);
    const syncedSet = deps.store.getSyncedUpstreamMessageIdSet(sessionID);
    const unsynced = extractUpstreamOnlyMessages(upstreamList, localList, syncedSet);
    if (unsynced.length === 0) {
      return { handoverContext: null, upstreamMessageIds: [] };
    }
    return {
      handoverContext: formatMessagesAsHandoverContext(unsynced),
      upstreamMessageIds: unsynced.map((m) => m.id).filter(Boolean),
    };
  }

  async function syncAgyContextToUpstream(sessionID, req, expectedAuth) {
    const unsyncedAgy = deps.store
      .getUnsyncedAgyMessages(sessionID)
      .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'compaction');
    if (unsyncedAgy.length === 0) return;

    const text = formatMessagesAsHandoverContext(unsyncedAgy, {
      header: 'Previous conversation context from agy-cli before switching models (continue seamlessly):',
      maxChars: 12_000,
    });
    if (!text) return;

    try {
      const up = await fetchUpstream({
        upstreamBase: deps.upstreamBase(),
        authHeader: expectedAuth,
        req,
        method: 'POST',
        pathAndQuery: `/api/session/${encodeURIComponent(sessionID)}/synthetic`,
        body: Buffer.from(
          JSON.stringify({
            text,
            description: 'Synced agy-cli conversation context',
            resume: false,
          }),
          'utf8',
        ),
      });
      if (up.ok) {
        deps.store.markAgyMessagesSynced(
          sessionID,
          unsyncedAgy.map((m) => m.id).filter(Boolean),
        );
      }
    } catch {
      // Best-effort upstream context sync; do not block model switch or prompt
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const expectedClientAuth = getClientAuth();
      if (expectedClientAuth && req.headers.authorization !== expectedClientAuth) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      const expectedAuth = deps.authHeader();

      const method = req.method || 'GET';
      const rawUrl = req.url || '/';
      const url = new URL(rawUrl, 'http://127.0.0.1');
      const pathname = url.pathname;
      const pathAndQuery = `${pathname}${url.search}`;
      const directory = requestDirectory(req, url);

      // 1. SSE Event Stream (multiplexed)
      if (method === 'GET' && pathname === '/api/event') {
        deps.sseHub.handleSubscribe(req, res);
        return;
      }

      // 2. Virtual Provider Injection
      if (method === 'GET' && pathname === '/api/provider') {
        const up = await fetchUpstream({
          upstreamBase: deps.upstreamBase(),
          authHeader: expectedAuth,
          req,
          method,
          pathAndQuery,
        });
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }
        const json = JSON.parse(text);
        const catalog = loadCatalog();
        const existing = Array.isArray(json.data) ? json.data : [];
        const filtered = existing.filter((p) => p?.id !== AGY_PROVIDER_ID);
        json.data = [...filtered, catalog.provider];
        sendJson(res, up.status, json);
        return;
      }

      // 3. Virtual Model Injection
      if (method === 'GET' && pathname === '/api/model') {
        const up = await fetchUpstream({
          upstreamBase: deps.upstreamBase(),
          authHeader: expectedAuth,
          req,
          method,
          pathAndQuery,
        });
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }
        const types = url.searchParams.getAll('types').flatMap((v) => v.split(',')).filter(Boolean);
        const wantsChat = types.length === 0 || types.includes('chat');
        const json = JSON.parse(text);
        if (wantsChat) {
          const catalog = loadCatalog();
          const existing = Array.isArray(json.data) ? json.data : [];
          const filtered = existing.filter((m) => m?.providerID !== AGY_PROVIDER_ID);
          json.data = [...filtered, ...catalog.models];
        }
        sendJson(res, up.status, json);
        return;
      }

      // 4. Stateless Experimental Text Generation (Small Model / Session Assist)
      if (method === 'POST' && pathname === '/api/experimental/generate/text') {
        const bodyBuf = await readBodyBuffer(req);
        let parsed = {};
        try {
          parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
        } catch {}

        const targetModel = parsed?.model;
        if (targetModel?.providerID === AGY_PROVIDER_ID) {
          const prompt = String(parsed?.prompt || '');
          const modelID = String(targetModel?.id || targetModel?.modelID || '').trim();
          if (!prompt.trim()) {
            sendJson(res, 400, { error: 'prompt is required' });
            return;
          }
          if (!modelID) {
            sendJson(res, 400, { error: 'model.id is required' });
            return;
          }

          const ac = new AbortController();
          const onResClose = () => {
            if (!res.writableEnded) ac.abort();
          };
          res.on('close', onResClose);

          try {
            const text = await deps.agyRunner.generateText({
              prompt,
              modelID,
              variant: targetModel?.variant,
              directory,
              signal: ac.signal,
            });
            if (!res.writableEnded) {
              sendJson(res, 200, { data: { text } });
            }
          } catch (error) {
            if (!res.writableEnded) {
              sendJson(res, 502, { error: error?.message || 'agy-cli generate.text failed' });
            }
          } finally {
            res.off('close', onResClose);
          }
          return;
        }

        // Non-agy-cli model -> forward to internal OpenCode
        const up = await fetchUpstream({
          upstreamBase: deps.upstreamBase(),
          authHeader: expectedAuth,
          req,
          method,
          pathAndQuery,
          body: bodyBuf,
        });
        const text = await up.text();
        res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
        res.end(text);
        return;
      }

      // 5. Create Session (strip virtual agy-cli model before sending to OpenCode, overlay back on reply)
      if (method === 'POST' && pathname === '/api/session') {
        const bodyBuf = await readBodyBuffer(req);
        let parsed = {};
        try {
          parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
        } catch {}

        const wantsAgy = parsed?.model?.providerID === AGY_PROVIDER_ID;
        const forwarded = wantsAgy ? { ...parsed } : parsed;
        if (wantsAgy) delete forwarded.model;

        const up = await fetchUpstream({
          upstreamBase: deps.upstreamBase(),
          authHeader: expectedAuth,
          req,
          method,
          pathAndQuery,
          body: Buffer.from(JSON.stringify(forwarded), 'utf8'),
        });
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        const json = JSON.parse(text);
        if (json?.data?.id) {
          if (directory) deps.store.setSessionDirectory(json.data.id, directory);
          if (typeof parsed?.agent === 'string' && parsed.agent.trim()) {
            deps.store.setSessionAgent(json.data.id, parsed.agent.trim());
          }
          if (wantsAgy) {
            deps.store.setSessionModel(json.data.id, parsed.model);
          }
          deps.store.cacheSessionMetadata(json.data);
          json.data = deps.store.overlaySessionInfo(json.data);
        }
        sendJson(res, up.status, json);
        return;
      }

      // 5. Active Sessions (merge upstream + active agy turns)
      if (method === 'GET' && pathname === '/api/session/active') {
        const up = await fetchUpstream({
          upstreamBase: deps.upstreamBase(),
          authHeader: expectedAuth,
          req,
          method,
          pathAndQuery,
        });
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }
        const json = JSON.parse(text);
        const data = json.data && typeof json.data === 'object' ? { ...json.data } : {};
        for (const sid of deps.agyRunner.activeSessionIds()) {
          data[sid] = { type: 'running' };
        }
        json.data = data;
        sendJson(res, up.status, json);
        return;
      }

      // 6. List Sessions (overlay active agy-cli model & timestamps)
      if (method === 'GET' && pathname === '/api/session') {
        const up = await fetchUpstream({
          upstreamBase: deps.upstreamBase(),
          authHeader: expectedAuth,
          req,
          method,
          pathAndQuery,
        });
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }
        const json = JSON.parse(text);
        if (Array.isArray(json.data)) {
          const seenIds = new Set();
          json.data = json.data.map((s) => {
            if (s?.id) seenIds.add(s.id);
            deps.store.cacheSessionMetadata(s);
            return deps.store.overlaySessionInfo(s);
          });
          for (const child of deps.store.listChildSessions({ directory })) {
            deps.agyRunner.syncChildSession?.(child.id);
          }
          for (const child of deps.store.listChildSessions({ directory })) {
            if (!seenIds.has(child.id)) {
              json.data.push(child);
            }
          }
        }
        sendJson(res, up.status, json);
        return;
      }

      // Session-scoped routes: /api/session/:sessionID[/...]
      const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
      if (sessionMatch) {
        const sessionID = decodeURIComponent(sessionMatch[1]);
        const sub = sessionMatch[2] || '';

        if (directory && !isAgyChildSessionID(sessionID)) {
          deps.store.setSessionDirectory(sessionID, directory);
        }

        // 7a. Get Session Info
        if (method === 'GET' && sub === '') {
          if (isAgyChildSessionID(sessionID)) {
            deps.agyRunner.syncChildSession?.(sessionID);
            const childInfo = deps.store.getChildSessionInfo(sessionID);
            if (!childInfo) {
              sendJson(res, 404, { error: 'Child session not found' });
              return;
            }
            sendJson(res, 200, { data: childInfo });
            return;
          }
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
          });
          const text = await up.text();
          if (!up.ok) {
            res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
            res.end(text);
            return;
          }
          const json = JSON.parse(text);
          if (json?.data) {
            deps.store.cacheSessionMetadata(json.data);
            json.data = deps.store.overlaySessionInfo(json.data);
          }
          sendJson(res, up.status, json);
          return;
        }

        // 7b. Delete Session
        if (method === 'DELETE' && sub === '') {
          deps.agyRunner.interrupt(sessionID);
          deps.agyRunner.retireWorker?.(sessionID);
          deps.agyRunner.closeWatchersForParent?.(sessionID);
          deps.store.deleteSession(sessionID);
          if (isAgyChildSessionID(sessionID)) {
            sendJson(res, 200, { deleted: true });
            return;
          }
          // Fall through to upstream delete
        }

        // 7b-2. Patch Session (capture user/AI renames locally so auto-title never overwrites them)
        if (method === 'PATCH' && sub === '' && !isAgyChildSessionID(sessionID)) {
          const bodyBuf = await readBodyBuffer(req);
          let parsed = {};
          try {
            parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
          } catch {}
          if (typeof parsed?.title === 'string' && parsed.title.trim()) {
            deps.store.setSessionTitle(sessionID, parsed.title.trim());
          }
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const respHeaders = {};
          up.headers.forEach((val, key) => {
            const lower = key.toLowerCase();
            if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'content-length') return;
            respHeaders[key] = val;
          });
          const outBuf = Buffer.from(await up.arrayBuffer());
          respHeaders['content-length'] = String(outBuf.length);
          res.writeHead(up.status, respHeaders);
          res.end(outBuf);
          return;
        }

        // 7c. Switch Session Model (route decision state)
        if (method === 'POST' && sub === 'model') {
          const bodyBuf = await readBodyBuffer(req);
          let parsed = {};
          try {
            parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
          } catch {}

          const nextModel = parsed?.model;
          if (nextModel?.providerID === AGY_PROVIDER_ID) {
            const prev = deps.store.getSession(sessionID)?.activeModel || undefined;
            deps.store.setSessionModel(sessionID, nextModel);
            if (prev?.providerID !== AGY_PROVIDER_ID) {
              deps.store.setNeedsUpstreamSync(sessionID, true);
            }
            deps.sseHub.broadcast({
              type: 'session.model.selected',
              ...(directory ? { location: { directory } } : {}),
              data: {
                sessionID,
                model: nextModel,
                ...(prev ? { previous: prev } : {}),
              },
            });
            res.writeHead(204);
            res.end();
            return;
          }

          // Switching back to a native OpenCode model: sync any unsynced agy-cli turns upstream first
          await syncAgyContextToUpstream(sessionID, req, expectedAuth);
          deps.store.setSessionModel(sessionID, null);
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7c-2. Switch Session Agent / Mode (e.g. build <-> plan)
        if (method === 'POST' && sub === 'agent') {
          const bodyBuf = await readBodyBuffer(req);
          let parsed = {};
          try {
            parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
          } catch {}

          const nextAgent = typeof parsed?.agent === 'string' && parsed.agent.trim() ? parsed.agent.trim() : null;
          const sessionState = deps.store.getSession(sessionID);
          const prevAgent = sessionState?.agent || undefined;
          deps.store.setSessionAgent(sessionID, nextAgent);

          if (sessionState?.activeModel?.providerID === AGY_PROVIDER_ID && nextAgent) {
            const effectiveDir = directory || sessionState?.directory || null;
            deps.sseHub.broadcast({
              type: 'session.agent.selected',
              ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
              data: {
                sessionID,
                agent: nextAgent,
                ...(prevAgent && prevAgent !== nextAgent ? { previous: prevAgent } : {}),
              },
            });
            res.writeHead(204);
            res.end();
            return;
          }

          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7d. Send Prompt (route by activeModel.providerID === 'agy-cli')
        if (method === 'POST' && sub === 'prompt') {
          const bodyBuf = await readBodyBuffer(req);
          const sessionState = deps.store.getSession(sessionID);
          const activeModel = sessionState?.activeModel;

          if (activeModel?.providerID === AGY_PROVIDER_ID) {
            let parsed = {};
            try {
              parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
            } catch {}

            if (typeof parsed?.agent === 'string' && parsed.agent.trim()) {
              deps.store.setSessionAgent(sessionID, parsed.agent.trim());
            }
            const activeAgent = deps.store.getSession(sessionID)?.agent || undefined;

            const messageID = parsed.id || `msg_${Date.now()}_u`;
            const now = Date.now();
            const normalizedFiles = Array.isArray(parsed.files) ? normalizePromptFiles(parsed.files) : undefined;
            const userPayload = {
              text: String(parsed.text || ''),
              ...(normalizedFiles ? { files: normalizedFiles } : {}),
              ...(Array.isArray(parsed.agents) ? { agents: parsed.agents } : {}),
              ...(Array.isArray(parsed.skills) ? { skills: parsed.skills } : {}),
              ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
            };

            const userMessage = {
              id: messageID,
              type: 'user',
              time: { created: now },
              ...userPayload,
            };
            deps.store.upsertMessage(sessionID, userMessage);

            const effectiveDir = directory || sessionState?.directory || null;
            const delivery = parsed.delivery === 'steer' ? 'steer' : 'queue';
            const handover = await prepareAgyHandoverContext(sessionID, req, expectedAuth);

            await deps.agyRunner.submitTurnInput(sessionID, {
              messageID,
              itemType: 'user',
              delivery,
              created: now,
              inboxPayload: userPayload,
              modelID: activeModel.id,
              variant: activeModel.variant,
              agent: activeAgent,
              directory: effectiveDir,
              handoverContext: handover.handoverContext,
              promptPayload: userPayload,
            });
            deps.store.markUpstreamMessagesSynced(sessionID, handover.upstreamMessageIds);

            sendJson(res, 200, {
              data: {
                id: messageID,
                type: 'user',
                time: { created: now },
                delivery,
                payload: userPayload,
              },
            });
            return;
          }

          // Native OpenCode prompt: ensure any prior agy-cli turns are synced upstream first
          await syncAgyContextToUpstream(sessionID, req, expectedAuth);
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7d-2. Synthetic Input (openui-lang interactive answers & attached skill/selection context)
        if (method === 'POST' && sub === 'synthetic') {
          const bodyBuf = await readBodyBuffer(req);
          const sessionState = deps.store.getSession(sessionID);
          const activeModel = sessionState?.activeModel;

          if (activeModel?.providerID === AGY_PROVIDER_ID) {
            let parsed = {};
            try {
              parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
            } catch {}

            const messageID = parsed.id || `msg_${Date.now()}_syn`;
            const now = Date.now();
            const text = String(parsed.text || '');
            const syntheticMsg = {
              id: messageID,
              type: 'synthetic',
              time: { created: now },
              text,
              ...(typeof parsed.description === 'string' && parsed.description ? { description: parsed.description } : {}),
              ...(parsed.metadata && typeof parsed.metadata === 'object' ? { metadata: parsed.metadata } : {}),
            };
            deps.store.upsertMessage(sessionID, syntheticMsg);

            if (parsed.resume === false) {
              deps.store.queuePendingSynthetic(sessionID, text);
              sendJson(res, 200, { data: syntheticMsg });
              return;
            }

            const activeAgent = deps.store.getSession(sessionID)?.agent || undefined;
            const effectiveDir = directory || sessionState?.directory || null;
            const delivery = parsed.delivery === 'steer' ? 'steer' : 'queue';
            const handover = await prepareAgyHandoverContext(sessionID, req, expectedAuth);
            const syntheticPayload = {
              text,
              ...(syntheticMsg.description ? { description: syntheticMsg.description } : {}),
              ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
            };

            await deps.agyRunner.submitTurnInput(sessionID, {
              messageID,
              itemType: 'synthetic',
              delivery,
              created: now,
              inboxPayload: syntheticPayload,
              modelID: activeModel.id,
              variant: activeModel.variant,
              agent: activeAgent,
              directory: effectiveDir,
              handoverContext: handover.handoverContext,
              promptPayload: { text },
            });
            deps.store.markUpstreamMessagesSynced(sessionID, handover.upstreamMessageIds);

            sendJson(res, 200, { data: syntheticMsg });
            return;
          }

          // Native OpenCode synthetic
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7d-3. Compact Session (route agy-cli sessions to native ACP `/compact` or pre-switch upstream summary)
        if (method === 'POST' && sub === 'compact') {
          const bodyBuf = await readBodyBuffer(req);
          const sessionState = deps.store.getSession(sessionID);
          const activeModel = sessionState?.activeModel;

          if (activeModel?.providerID === AGY_PROVIDER_ID) {
            let parsed = {};
            try {
              parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
            } catch {}

            const handover = await prepareAgyHandoverContext(sessionID, req, expectedAuth);
            const hasHistory =
              Boolean(sessionState?.agyConversationId) ||
              deps.store.getMessages(sessionID).length > 0 ||
              Boolean(handover.handoverContext);
            if (!hasHistory) {
              sendJson(res, 400, { error: 'Nothing to compact yet' });
              return;
            }
            if (deps.agyRunner.isRunning(sessionID)) {
              sendJson(res, 409, { error: 'Session is busy' });
              return;
            }

            const effectiveDir = directory || sessionState?.directory || null;
            const started = await deps.agyRunner.compactSession({
              sessionID,
              modelID: activeModel.id,
              variant: activeModel.variant,
              directory: effectiveDir,
              messageID: parsed.id,
              upstreamHandoverContext: handover.handoverContext,
              upstreamCompactionPrompt: handover.handoverContext
                ? buildUpstreamCompactionPrompt(handover.handoverContext)
                : null,
            });
            if (!started.ok) {
              sendJson(res, started.status || 409, { error: started.error || 'Session is busy' });
              return;
            }
            deps.store.markUpstreamMessagesSynced(sessionID, handover.upstreamMessageIds);

            sendJson(res, 200, {
              data: {
                id: started.messageID,
                type: 'compaction',
                time: { created: started.created },
                delivery: parsed.delivery || 'queue',
              },
            });
            return;
          }

          // Native OpenCode compact
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7d-4. Slash Commands (route agy-cli commands cleanly; support `/compact` or command prompt)
        if (method === 'POST' && sub === 'command') {
          const bodyBuf = await readBodyBuffer(req);
          const sessionState = deps.store.getSession(sessionID);
          const activeModel = sessionState?.activeModel;

          if (activeModel?.providerID === AGY_PROVIDER_ID) {
            let parsed = {};
            try {
              parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
            } catch {}

            const cmdName = String(parsed?.name || '').trim().replace(/^\/+/, '');
            const cmdText = String(parsed?.text || '').trim();
            if (!cmdName) {
              sendJson(res, 400, { error: 'command name is required' });
              return;
            }

            if (cmdName.toLowerCase() === 'compact' && !cmdText) {
              const handover = await prepareAgyHandoverContext(sessionID, req, expectedAuth);
              const started = await deps.agyRunner.compactSession({
                sessionID,
                modelID: activeModel.id,
                variant: activeModel.variant,
                directory: directory || sessionState?.directory || null,
                upstreamHandoverContext: handover.handoverContext,
                upstreamCompactionPrompt: handover.handoverContext
                  ? buildUpstreamCompactionPrompt(handover.handoverContext)
                  : null,
              });
              if (!started.ok) {
                sendJson(res, started.status || 409, { error: started.error || 'Session is busy' });
                return;
              }
              deps.store.markUpstreamMessagesSynced(sessionID, handover.upstreamMessageIds);
              res.writeHead(204);
              res.end();
              return;
            }

            const fullText = cmdText ? `/${cmdName} ${cmdText}` : `/${cmdName}`;
            const messageID = `msg_${Date.now()}_cmd`;
            const now = Date.now();
            const normalizedFiles = Array.isArray(parsed.files) ? normalizePromptFiles(parsed.files) : undefined;
            const userPayload = {
              text: fullText,
              ...(normalizedFiles ? { files: normalizedFiles } : {}),
              ...(Array.isArray(parsed.agents) ? { agents: parsed.agents } : {}),
              ...(Array.isArray(parsed.skills) ? { skills: parsed.skills } : {}),
            };
            deps.store.upsertMessage(sessionID, { id: messageID, type: 'user', time: { created: now }, ...userPayload });

            const effectiveDir = directory || sessionState?.directory || null;
            const delivery = parsed.delivery === 'steer' ? 'steer' : 'queue';
            const handover = await prepareAgyHandoverContext(sessionID, req, expectedAuth);
            const activeAgent = deps.store.getSession(sessionID)?.agent || undefined;

            await deps.agyRunner.submitTurnInput(sessionID, {
              messageID,
              itemType: 'user',
              delivery,
              created: now,
              inboxPayload: userPayload,
              modelID: activeModel.id,
              variant: activeModel.variant,
              agent: activeAgent,
              directory: effectiveDir,
              handoverContext: handover.handoverContext,
              promptPayload: userPayload,
            });
            deps.store.markUpstreamMessagesSynced(sessionID, handover.upstreamMessageIds);
            res.writeHead(204);
            res.end();
            return;
          }

          await syncAgyContextToUpstream(sessionID, req, expectedAuth);
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7d-5. Fork Session (carry activeModel, agent, local agy turns & handover context)
        if (method === 'POST' && sub === 'fork') {
          const bodyBuf = await readBodyBuffer(req);
          let parsed = {};
          try {
            parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
          } catch {}

          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          if (!up.ok) {
            res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
            res.end(text);
            return;
          }

          const json = JSON.parse(text);
          const newId = json?.data?.id;
          if (newId && deps.store.getSession(sessionID)) {
            const srcMsgs = deps.store.getMessages(sessionID);
            const beforeId = typeof parsed?.before === 'string' && parsed.before.trim() ? parsed.before.trim() : null;
            const cutIdx = beforeId ? srcMsgs.findIndex((m) => m?.id === beforeId) : srcMsgs.length;
            const copiedMsgs = srcMsgs.slice(0, cutIdx >= 0 ? cutIdx : srcMsgs.length);
            const handoverText = formatMessagesAsHandoverContext(copiedMsgs, {
              header: 'Conversation history inherited from forked parent session (continue seamlessly):',
            });
            deps.store.forkSessionState(sessionID, newId, {
              beforeMessageID: beforeId,
              handoverContext: handoverText || null,
              syncedUpstreamMsgIds: [...deps.store.getSyncedUpstreamMessageIdSet(sessionID)],
            });
            json.data = deps.store.overlaySessionInfo(json.data);
          }
          sendJson(res, up.status, json);
          return;
        }

        // 7d-6. Revert Stage / Clear / Commit (keep local agy-cli history & warm ACP worker in sync)
        if (method === 'POST' && sub === 'revert/stage') {
          const bodyBuf = await readBodyBuffer(req);
          let parsed = {};
          try {
            parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
          } catch {}
          if (typeof parsed?.messageID === 'string' && parsed.messageID.trim()) {
            deps.store.setStagedRevertTarget(sessionID, parsed.messageID.trim());
          }
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        if (method === 'DELETE' && sub === 'revert') {
          deps.store.setStagedRevertTarget(sessionID, null);
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        if (method === 'POST' && sub === 'revert/commit') {
          const bodyBuf = await readBodyBuffer(req);
          const stagedTarget = deps.store.getStagedRevertTarget(sessionID);
          const up = await fetchUpstream({
            upstreamBase: deps.upstreamBase(),
            authHeader: expectedAuth,
            req,
            method,
            pathAndQuery,
            body: bodyBuf,
          });
          const text = await up.text();
          if (up.ok && stagedTarget) {
            const { removedAgyTurns } = deps.store.truncateMessagesFrom(sessionID, stagedTarget);
            if (removedAgyTurns) {
              deps.agyRunner.retireWorker?.(sessionID);
            }
          }
          res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
          res.end(text);
          return;
        }

        // 7d-7. Session Inbox (list / promote queue->steer / cancel pending inputs)
        if (method === 'GET' && sub === 'inbox') {
          if (isAgyChildSessionID(sessionID)) {
            sendJson(res, 200, { data: [] });
            return;
          }
          const sessionState = deps.store.getSession(sessionID);
          const pending = deps.agyRunner.listInbox?.(sessionID) || [];
          if (sessionState?.activeModel?.providerID === AGY_PROVIDER_ID || pending.length > 0) {
            sendJson(res, 200, { data: pending });
            return;
          }
        }

        const inboxItemMatch = sub.match(/^inbox\/([^/]+)$/);
        if (inboxItemMatch && (method === 'PATCH' || method === 'DELETE')) {
          const inboxID = decodeURIComponent(inboxItemMatch[1]);
          if (isAgyChildSessionID(sessionID)) {
            res.writeHead(204);
            res.end();
            return;
          }
          const sessionState = deps.store.getSession(sessionID);
          const pending = deps.agyRunner.listInbox?.(sessionID) || [];
          const hasPending = pending.some((item) => item?.id === inboxID);
          if (sessionState?.activeModel?.providerID === AGY_PROVIDER_ID || hasPending) {
            if (method === 'DELETE') {
              deps.agyRunner.cancelInboxItem?.(sessionID, inboxID);
              res.writeHead(204);
              res.end();
              return;
            }
            const bodyBuf = await readBodyBuffer(req);
            let parsed = {};
            try {
              parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
            } catch {}
            const outcome = deps.agyRunner.updateInboxDelivery?.(sessionID, inboxID, parsed?.delivery);
            if (!outcome?.ok) {
              sendJson(res, outcome?.status || 409, { error: outcome?.error || `Pending input cannot change delivery: ${inboxID}` });
              return;
            }
            res.writeHead(204);
            res.end();
            return;
          }
        }

        // 7e. Interrupt Execution
        if (method === 'POST' && sub === 'interrupt') {
          if (deps.agyRunner.interrupt(sessionID)) {
            sendJson(res, 200, { interrupted: true });
            return;
          }
          if (isAgyChildSessionID(sessionID)) {
            sendJson(res, 200, { interrupted: false });
            return;
          }
        }

        // 7e-2. Get Single Message (serve local agy-cli message before falling back to upstream)
        const singleMsgMatch = sub.match(/^message\/([^/]+)$/);
        if (method === 'GET' && singleMsgMatch) {
          const targetId = decodeURIComponent(singleMsgMatch[1]);
          const localMsg = deps.store.getMessages(sessionID).find((m) => m?.id === targetId);
          if (localMsg) {
            sendJson(res, 200, { data: localMsg });
            return;
          }
        }

        // 7f. List Messages (merge OpenCode messages + local agy-cli messages with OpenCode-compatible cursor pagination)
        if (method === 'GET' && sub === 'message') {
          const limitParam = url.searchParams.get('limit');
          const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
          const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
          const order = url.searchParams.get('order') || undefined;
          const cursor = url.searchParams.get('cursor') || undefined;
          const type = url.searchParams.get('type') || undefined;

          if (isAgyChildSessionID(sessionID)) {
            deps.agyRunner.syncChildSession?.(sessionID);
            const page = deps.store.paginateMessages([], sessionID, { order, cursor, type, limit });
            if (page.invalidCursor) {
              sendJson(res, 400, { error: 'Invalid cursor' });
              return;
            }
            sendJson(res, 200, { data: page.data, cursor: page.cursor });
            return;
          }

          const inFlight = deps.agyRunner.getInFlightAssistantMessages
            ? deps.agyRunner.getInFlightAssistantMessages(sessionID)
            : (() => {
                const single = deps.agyRunner.getInFlightAssistantMessage?.(sessionID);
                return single ? [single] : [];
              })();
          const hasLocalMessages = deps.store.getMessages(sessionID).length > 0 || inFlight.length > 0;

          if (!hasLocalMessages) {
            const up = await fetchUpstream({
              upstreamBase: deps.upstreamBase(),
              authHeader: expectedAuth,
              req,
              method,
              pathAndQuery,
            });
            const text = await up.text();
            res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
            res.end(text);
            return;
          }

          const upResult = await fetchAllUpstreamMessagesResult(sessionID, req, expectedAuth, { type });
          if (!upResult.ok) {
            res.writeHead(upResult.status, { 'Content-Type': upResult.contentType || 'application/json' });
            res.end(upResult.text);
            return;
          }

          const page = deps.store.paginateMessages(upResult.messages, sessionID, {
            order,
            cursor,
            type,
            limit,
            ...(inFlight.length > 0 ? { extraMessages: inFlight } : {}),
          });
          if (page.invalidCursor) {
            sendJson(res, 400, { error: 'Invalid cursor' });
            return;
          }
          sendJson(res, 200, { data: page.data, cursor: page.cursor });
          return;
        }
      }

      // 8. Default: transparent reverse proxy to internal OpenCode
      const bodyBuf = method !== 'GET' && method !== 'HEAD' ? await readBodyBuffer(req) : null;
      const up = await fetchUpstream({
        upstreamBase: deps.upstreamBase(),
        authHeader: expectedAuth,
        req,
        method,
        pathAndQuery,
        body: bodyBuf,
      });

      const respHeaders = {};
      up.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'content-length') return;
        respHeaders[key] = val;
      });
      const outBuf = Buffer.from(await up.arrayBuffer());
      respHeaders['content-length'] = String(outBuf.length);
      res.writeHead(up.status, respHeaders);
      res.end(outBuf);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: error?.message || 'Router upstream error' });
      } else {
        res.end();
      }
    }
  });

  return server;
}
