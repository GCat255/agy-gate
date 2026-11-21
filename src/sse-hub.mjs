/**
 * Dual-source SSE hub that relays upstream OpenCode `/api/event` events
 * and multiplexes translated `agy-cli` OpenCodeEvents to all subscribed clients.
 */
export class SseHub {
  /**
   * @param {{ upstreamUrl: () => string, authHeader: () => string | null }} options
   */
  constructor(options) {
    this.upstreamUrl = options.upstreamUrl;
    this.authHeader = options.authHeader;
    /** @type {Set<{ res: import('node:http').ServerResponse, types: Set<string> | null }>} */
    this.clients = new Set();
    this.seq = 0;
    this.closed = false;
    this.upstreamAbort = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.res.writableEnded) {
          client.res.write(':heartbeat\n\n');
        }
      }
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  /** Start maintaining the upstream SSE subscription to internal OpenCode. */
  startUpstream() {
    if (this.closed || this.upstreamAbort) return;
    void this._connectUpstream();
  }

  async _connectUpstream() {
    while (!this.closed) {
      const ac = new AbortController();
      this.upstreamAbort = ac;
      try {
        const headers = { Accept: 'text/event-stream' };
        const auth = this.authHeader();
        if (auth) headers.Authorization = auth;

        const res = await fetch(`${this.upstreamUrl()}/api/event`, {
          headers,
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          await this._delay(1000);
          continue;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            this._handleUpstreamFrame(frame);
          }
        }
      } catch {
        // Reconnect after brief backoff unless closed
      } finally {
        this.upstreamAbort = null;
      }

      if (!this.closed) {
        await this._delay(1000);
      }
    }
  }

  /** @param {string} frame */
  _handleUpstreamFrame(frame) {
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    try {
      const parsed = JSON.parse(raw);
      // Downstream clients already receive an immediate `server.connected` on subscribe
      if (parsed?.type === 'server.connected') return;
      this.broadcast(parsed);
    } catch {
      // Ignore malformed SSE frames
    }
  }

  /** @param {number} ms */
  _delay(ms) {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, ms);
      this.reconnectTimer.unref();
    });
  }

  /**
   * Handle an incoming `GET /api/event` SSE subscription from OpenChamber.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  handleSubscribe(req, res) {
    const url = new URL(req.url || '/api/event', 'http://127.0.0.1');
    const typesParam = url.searchParams.getAll('types').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    const types = typesParam.length > 0 ? new Set(typesParam) : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const client = { res, types };
    this.clients.add(client);

    // Send initial server.connected matching OpenCode's SSE contract
    const hello = this._withEnvelope({ type: 'server.connected', data: {} });
    res.write(`data: ${JSON.stringify(hello)}\n\n`);

    req.on('close', () => {
      this.clients.delete(client);
    });
  }

  /**
   * Ensure event carries OpenCode's `id` and `created` envelope fields.
   * @param {any} event
   */
  _withEnvelope(event) {
    this.seq += 1;
    const now = typeof event.created === 'number' ? event.created : Date.now();
    return {
      id: event.id || `evt_${now}_${this.seq}`,
      created: now,
      ...event,
    };
  }

  /**
   * Broadcast an OpenCodeEvent to all matching SSE clients.
   * @param {any} event
   */
  broadcast(event) {
    const envelope = this._withEnvelope(event);
    const payload = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const client of this.clients) {
      if (client.res.writableEnded) continue;
      if (client.types && !client.types.has(envelope.type)) continue;
      client.res.write(payload);
    }
    return envelope;
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.upstreamAbort?.abort();
    } catch {}
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
