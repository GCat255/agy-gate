import fs from 'node:fs';
import path from 'node:path';
import { isUntitledSessionTitle } from '../agy/session-title.mjs';

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
    /** @type {Set<string>} */
    this.childIds = new Set();
    try {
      for (const name of fs.readdirSync(this.sessionsDir)) {
        if (name.startsWith('agy_sub_') && name.endsWith('.json')) {
          this.childIds.add(name.slice(0, -5));
        }
      }
    } catch {
      // Ignore scan errors on fresh directories
    }
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
      isChild: false,
      parentID: null,
      projectID: null,
      title: null,
      autoTitleState: null,
      agent: null,
      directory: null,
      activeModel: null,
      agyConversationId: null,
      pendingSynthetic: [],
      sessionTokens: null,
      lastAgyResultUsage: null,
      messages: [],
      createdAt: Date.now(),
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

  /**
   * Queue non-resuming synthetic context (`resume: false`) to prepend to the next `agy-cli` prompt.
   * @param {string} sessionID
   * @param {string} text
   */
  queuePendingSynthetic(sessionID, text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const s = this._ensureSession(sessionID);
    if (!Array.isArray(s.pendingSynthetic)) s.pendingSynthetic = [];
    s.pendingSynthetic.push(trimmed);
    this._save(sessionID);
  }

  /**
   * Consume and clear any queued non-resuming synthetic context for `sessionID`.
   * @param {string} sessionID
   * @returns {string[]}
   */
  consumePendingSynthetic(sessionID) {
    const s = this.getSession(sessionID);
    if (!s || !Array.isArray(s.pendingSynthetic) || s.pendingSynthetic.length === 0) {
      return [];
    }
    const items = [...s.pendingSynthetic];
    s.pendingSynthetic = [];
    this._save(sessionID);
    return items;
  }

  /**
   * Cache upstream `projectID` / `directory` / `title` for a parent session so virtual child
   * sessions inherit accurate admission fields.
   * @param {any} sessionInfo
   */
  cacheSessionMetadata(sessionInfo) {
    if (!sessionInfo || typeof sessionInfo !== 'object' || !sessionInfo.id) return;
    if (String(sessionInfo.id).startsWith('agy_sub_')) return;
    const s = this.getSession(sessionInfo.id);
    if (!s) return;
    let changed = false;
    if (sessionInfo.projectID && s.projectID !== sessionInfo.projectID) {
      s.projectID = sessionInfo.projectID;
      changed = true;
    }
    const dir = sessionInfo.location?.directory ?? sessionInfo.directory;
    if (dir && !s.directory) {
      s.directory = dir;
      changed = true;
    }
    if (typeof sessionInfo.title === 'string' && !isUntitledSessionTitle(sessionInfo.title)) {
      const trimmed = sessionInfo.title.trim();
      if (s.title !== trimmed || s.autoTitleState !== 'done') {
        s.title = trimmed;
        s.autoTitleState = 'done';
        changed = true;
      }
    }
    if (changed) this._save(sessionInfo.id);
  }

  /** @param {string} sessionID @param {string} title */
  setSessionTitle(sessionID, title) {
    const trimmed = String(title ?? '').trim();
    if (!trimmed) return;
    const s = this._ensureSession(sessionID);
    s.title = trimmed;
    s.autoTitleState = isUntitledSessionTitle(trimmed) ? null : 'done';
    this._save(sessionID);
  }

  /** @param {string} sessionID @param {'pending'|'done'|null} state */
  markAutoTitleState(sessionID, state) {
    const s = this._ensureSession(sessionID);
    s.autoTitleState = state;
    this._save(sessionID);
  }

  /** @param {string} sessionID */
  needsAutoTitle(sessionID) {
    const s = this.getSession(sessionID);
    if (!s || s.isChild) return false;
    if (s.autoTitleState === 'pending' || s.autoTitleState === 'done') return false;
    return isUntitledSessionTitle(s.title);
  }

  /**
   * Create or replace a virtual child session record for an `agy` subagent.
   * @param {{
   *   sessionID: string,
   *   parentID: string,
   *   projectID?: string | null,
   *   directory?: string | null,
   *   title?: string,
   *   agent?: string,
   *   model?: { providerID: string, id: string },
   *   agyConversationId?: string | null,
   *   createdAt?: number,
   * }} child
   */
  createChildSession(child) {
    const now = child.createdAt ?? Date.now();
    const record = {
      sessionID: child.sessionID,
      isChild: true,
      parentID: child.parentID,
      projectID: child.projectID || 'project_default',
      directory: child.directory || null,
      title: child.title || child.agent || 'Subagent',
      agent: child.agent || 'subagent',
      model: child.model || null,
      agyConversationId: child.agyConversationId || null,
      parentConversationId: child.parentConversationId || null,
      transcriptPath: child.transcriptPath || null,
      lastSyncedLineCount: child.lastSyncedLineCount ?? 0,
      busy: true,
      outcome: null,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      messages: [],
      createdAt: now,
      updatedAt: now,
      idleAt: null,
    };
    this.cache.set(child.sessionID, record);
    this.childIds.add(child.sessionID);
    this._save(child.sessionID);
    return record;
  }

  /** @param {string} childSessionID */
  getChildSessionRecord(childSessionID) {
    const s = this.getSession(childSessionID);
    return s?.isChild ? s : null;
  }

  /** @param {string} childSessionID */
  updateChildSession(childSessionID, patch) {
    const s = this.getSession(childSessionID);
    if (!s || !s.isChild) return null;
    if (patch.busy !== undefined) s.busy = patch.busy;
    if (patch.outcome !== undefined) s.outcome = patch.outcome;
    if (patch.tokens !== undefined) s.sessionTokens = patch.tokens;
    if (patch.model !== undefined) s.model = patch.model;
    if (patch.title !== undefined) s.title = patch.title;
    if (patch.transcriptPath !== undefined) s.transcriptPath = patch.transcriptPath;
    if (patch.parentConversationId !== undefined) s.parentConversationId = patch.parentConversationId;
    if (patch.lastSyncedLineCount !== undefined) s.lastSyncedLineCount = patch.lastSyncedLineCount;
    if (patch.time?.updated !== undefined) s.updatedAt = patch.time.updated;
    if (patch.time?.idle !== undefined) s.idleAt = patch.time.idle;
    this._save(childSessionID);
    return s;
  }

  /** @param {string} childSessionID @param {any[]} messages */
  replaceChildMessages(childSessionID, messages) {
    const s = this.getSession(childSessionID);
    if (!s || !s.isChild) return;
    s.messages = Array.isArray(messages) ? messages : [];
    this._save(childSessionID);
  }

  /** @param {string} childSessionID */
  getChildSessionInfo(childSessionID) {
    const s = this.getSession(childSessionID);
    if (!s || !s.isChild) return null;
    return {
      id: s.sessionID,
      parentID: s.parentID,
      projectID: s.projectID || 'project_default',
      directory: s.directory || '',
      location: { directory: s.directory || '' },
      title: s.title || s.agent || 'Subagent',
      agent: s.agent || 'subagent',
      ...(s.model ? { model: s.model } : {}),
      cost: 0,
      tokens: s.sessionTokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(s.outcome ? { outcome: s.outcome } : {}),
      time: {
        created: s.createdAt || s.updatedAt || Date.now(),
        updated: s.updatedAt || Date.now(),
        ...(!s.busy && s.idleAt ? { idle: s.idleAt } : {}),
      },
    };
  }

  /** @param {{ directory?: string | null }} [opts] */
  listChildSessions(opts = {}) {
    const filterDir = opts.directory ? String(opts.directory).trim().toLowerCase() : null;
    const out = [];
    for (const cid of this.childIds) {
      const info = this.getChildSessionInfo(cid);
      if (!info) continue;
      if (filterDir && String(info.directory || '').trim().toLowerCase() !== filterDir) continue;
      out.push(info);
    }
    return out;
  }

  /** @param {string} sessionID */
  deleteSession(sessionID) {
    this.cache.delete(sessionID);
    this.childIds.delete(sessionID);
    try {
      fs.unlinkSync(this._filePath(sessionID));
    } catch {
      // Ignore missing files
    }
    for (const cid of [...this.childIds]) {
      const c = this.getSession(cid);
      if (c?.parentID === sessionID) {
        this.deleteSession(cid);
      }
    }
  }

  /**
   * Persist cumulative session token totals and last `agy` `result.usage` baseline.
   * @param {string} sessionID
   * @param {{ sessionTokens?: any, lastResultUsage?: any }} usage
   */
  recordTurnUsage(sessionID, usage) {
    if (!usage || typeof usage !== 'object') return;
    const s = this._ensureSession(sessionID);
    if (usage.sessionTokens) {
      s.sessionTokens = usage.sessionTokens;
    }
    if (usage.lastResultUsage) {
      s.lastAgyResultUsage = usage.lastResultUsage;
    }
    this._save(sessionID);
  }

  /**
   * Overlay `agy-cli` model and cumulative usage onto an OpenCode Session.Info record when active.
   * @param {any} sessionInfo
   */
  overlaySessionInfo(sessionInfo) {
    if (!sessionInfo || typeof sessionInfo !== 'object' || !sessionInfo.id) return sessionInfo;
    const s = this.getSession(sessionInfo.id);
    if (!s) return sessionInfo;
    const next = { ...sessionInfo };
    if (s.title && isUntitledSessionTitle(next.title)) {
      next.title = s.title;
    }
    if (s.activeModel) {
      next.model = s.activeModel;
    }
    if (s.sessionTokens) {
      next.tokens = s.sessionTokens;
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
