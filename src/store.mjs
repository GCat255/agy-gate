import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistent store for `agy-cli` session bindings, model overrides, and messages.
 * One JSON file per session under `<dataDir>/sessions/` with atomic temp-file writes.
 */
export class RouterStore {
  /**
   * @param {string} dataDir
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(dataDir, 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    /** @type {Map<string, any>} */
    this.cache = new Map();
  }

  /** @param {string} sessionID */
  _filePath(sessionID) {
    const safe = String(sessionID).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.sessionsDir, `${safe}.json`);
  }

  /** @param {string} sessionID */
  getSession(sessionID) {
    if (this.cache.has(sessionID)) return this.cache.get(sessionID);
    const file = this._filePath(sessionID);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.cache.set(sessionID, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** @param {string} sessionID */
  _ensureSession(sessionID) {
    const existing = this.getSession(sessionID);
    if (existing) return existing;
    const created = {
      sessionID,
      directory: null,
      activeModel: null,
      agyConversationId: null,
      messages: [],
      updatedAt: Date.now(),
    };
    this.cache.set(sessionID, created);
    return created;
  }

  /** @param {string} sessionID */
  _save(sessionID) {
    const state = this.cache.get(sessionID);
    if (!state) return;
    state.updatedAt = Date.now();
    const target = this._filePath(sessionID);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  }

  /**
   * @param {string} sessionID
   * @param {string | null | undefined} directory
   */
  setSessionDirectory(sessionID, directory) {
    if (!directory) return;
    const s = this._ensureSession(sessionID);
    if (s.directory === directory) return;
    s.directory = directory;
    this._save(sessionID);
  }

  /**
   * @param {string} sessionID
   * @param {{ providerID: string, id: string, variant?: string } | null} model
   */
  setSessionModel(sessionID, model) {
    const s = this._ensureSession(sessionID);
    s.activeModel = model ? { ...model } : null;
    this._save(sessionID);
  }

  /**
   * @param {string} sessionID
   * @param {string} conversationId
   */
  setAgyConversationId(sessionID, conversationId) {
    if (!conversationId) return;
    const s = this._ensureSession(sessionID);
    if (s.agyConversationId === conversationId) return;
    s.agyConversationId = conversationId;
    this._save(sessionID);
  }

  /**
   * @param {string} sessionID
   * @param {any} msg
   */
  upsertMessage(sessionID, msg) {
    const s = this._ensureSession(sessionID);
    const idx = s.messages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      s.messages[idx] = msg;
    } else {
      s.messages.push(msg);
    }
    this._save(sessionID);
  }

  /** @param {string} sessionID */
  getMessages(sessionID) {
    const s = this.getSession(sessionID);
    return s && Array.isArray(s.messages) ? s.messages : [];
  }

  /** @param {string} sessionID */
  deleteSession(sessionID) {
    this.cache.delete(sessionID);
    try {
      fs.unlinkSync(this._filePath(sessionID));
    } catch {
      // Ignore missing files
    }
  }

  /**
   * Overlay `agy-cli` model onto an OpenCode Session.Info record when active.
   * @param {any} sessionInfo
   */
  overlaySessionInfo(sessionInfo) {
    if (!sessionInfo || typeof sessionInfo !== 'object' || !sessionInfo.id) return sessionInfo;
    const s = this.getSession(sessionInfo.id);
    if (!s) return sessionInfo;
    const next = { ...sessionInfo };
    if (s.activeModel) {
      next.model = s.activeModel;
    }
    if (typeof s.updatedAt === 'number' && next.time && typeof next.time.updated === 'number') {
      if (s.updatedAt > next.time.updated) {
        next.time = { ...next.time, updated: s.updatedAt };
      }
    }
    return next;
  }

  /**
   * Merge upstream OpenCode messages with locally persisted `agy-cli` messages.
   * @param {any[]} upstreamMessages
   * @param {string} sessionID
   * @param {{ order?: string, type?: string, limit?: number }} [query]
   */
  mergeMessages(upstreamMessages, sessionID, query = {}) {
    const local = this.getMessages(sessionID);
    if (local.length === 0) return upstreamMessages;

    const byId = new Map();
    for (const msg of upstreamMessages || []) {
      if (msg?.id) byId.set(msg.id, msg);
    }
    for (const msg of local) {
      if (!msg?.id) continue;
      if (query.type && msg.type !== query.type) continue;
      byId.set(msg.id, msg);
    }

    const merged = [...byId.values()];
    merged.sort((a, b) => {
      const ta = a?.time?.created ?? 0;
      const tb = b?.time?.created ?? 0;
      if (ta !== tb) return query.order === 'desc' ? tb - ta : ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });

    if (typeof query.limit === 'number' && query.limit > 0 && merged.length > query.limit) {
      return merged.slice(0, query.limit);
    }
    return merged;
  }
}
