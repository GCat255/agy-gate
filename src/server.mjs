import http from 'node:http';
import { AGY_PROVIDER_ID, getAgyCatalog } from './agy-models.mjs';
import { isAgyChildSessionID } from './subagent-bridge.mjs';

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
          if (wantsAgy) {
            deps.store.setSessionModel(json.data.id, parsed.model);
            deps.store.cacheSessionMetadata(json.data);
            json.data = deps.store.overlaySessionInfo(json.data);
          }
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

          // Switching back to a native OpenCode model
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

            const messageID = parsed.id || `msg_${Date.now()}_u`;
            const now = Date.now();
            const userPayload = {
              text: String(parsed.text || ''),
              ...(Array.isArray(parsed.files) ? { files: parsed.files } : {}),
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
            deps.sseHub.broadcast({
              type: 'session.inbox.enqueued',
              created: now,
              ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
              data: {
                sessionID,
                inboxID: messageID,
                item: { type: 'user', payload: userPayload },
              },
            });
            deps.sseHub.broadcast({
              type: 'session.inbox.delivered',
              created: now,
              ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
              data: { sessionID, inboxID: messageID },
            });

            const started = await deps.agyRunner.startTurn({
              sessionID,
              modelID: activeModel.id,
              variant: activeModel.variant,
              directory: effectiveDir,
              promptPayload: userPayload,
            });
            if (!started.ok) {
              sendJson(res, 409, { error: 'Session is busy' });
              return;
            }

            sendJson(res, 200, {
              data: {
                id: messageID,
                type: 'user',
                time: { created: now },
                delivery: parsed.delivery || 'queue',
                payload: userPayload,
              },
            });
            return;
          }

          // Native OpenCode prompt
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

            const effectiveDir = directory || sessionState?.directory || null;
            deps.sseHub.broadcast({
              type: 'session.inbox.enqueued',
              created: now,
              ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
              data: {
                sessionID,
                inboxID: messageID,
                item: {
                  type: 'synthetic',
                  payload: {
                    text,
                    ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
                  },
                },
              },
            });
            deps.sseHub.broadcast({
              type: 'session.inbox.delivered',
              created: now,
              ...(effectiveDir ? { location: { directory: effectiveDir } } : {}),
              data: { sessionID, inboxID: messageID },
            });

            const started = await deps.agyRunner.startTurn({
              sessionID,
              modelID: activeModel.id,
              variant: activeModel.variant,
              directory: effectiveDir,
              promptPayload: { text },
            });
            if (!started.ok) {
              deps.agyRunner.enqueueTurnInput(sessionID, {
                modelID: activeModel.id,
                variant: activeModel.variant,
                directory: effectiveDir,
                promptPayload: { text },
              });
            }

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

        // 7e. Interrupt Execution
        if (method === 'POST' && sub === 'interrupt') {
          if (deps.agyRunner.interrupt(sessionID)) {
            sendJson(res, 200, { interrupted: true });
            return;
          }
        }

        // 7f. List Messages (merge OpenCode messages + local agy-cli messages)
        if (method === 'GET' && sub === 'message') {
          if (isAgyChildSessionID(sessionID)) {
            deps.agyRunner.syncChildSession?.(sessionID);
            const limitParam = url.searchParams.get('limit');
            const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
            const order = url.searchParams.get('order') || undefined;
            const type = url.searchParams.get('type') || undefined;
            const data = deps.store.mergeMessages([], sessionID, { order, type, limit });
            sendJson(res, 200, { data });
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
          const limit = url.searchParams.get('limit');
          json.data = deps.store.mergeMessages(Array.isArray(json.data) ? json.data : [], sessionID, {
            order: url.searchParams.get('order') || undefined,
            type: url.searchParams.get('type') || undefined,
            limit: limit ? Number.parseInt(limit, 10) : undefined,
          });
          sendJson(res, up.status, json);
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
