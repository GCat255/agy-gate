(() => {
  const CHANNEL = 'openchamber.sdk';
  const VERSION = 1;
  const pending = new Map();
  let nextSeq = 1;
  let pollTimer = null;
  let currentAuthUrl = '';

  const els = {
    statusBadge: document.getElementById('status-badge'),
    accountDesc: document.getElementById('account-desc'),
    loginBtn: document.getElementById('login-btn'),
    refreshBtn: document.getElementById('refresh-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    pendingBox: document.getElementById('pending-box'),
    openUrlBtn: document.getElementById('open-url-btn'),
    copyUrlBtn: document.getElementById('copy-url-btn'),
    manualInput: document.getElementById('manual-input'),
    manualSubmitBtn: document.getElementById('manual-submit-btn'),
    errorText: document.getElementById('error-text'),
    quotaCard: document.getElementById('quota-card'),
    planBadge: document.getElementById('plan-badge'),
    quotaList: document.getElementById('quota-list'),
  };

  function postToHost(msg) {
    window.parent.postMessage(msg, '*');
  }

  function callHost(type, payload) {
    const id = `agy-quota-${nextSeq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('与 OpenChamber 宿主通信超时。'));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      const msg = { channel: CHANNEL, v: VERSION, type, id };
      if (payload !== undefined) msg.payload = payload;
      postToHost(msg);
    });
  }

  async function serviceJson(method, path, bodyObj) {
    const result = await callHost('service-request', {
      method,
      path,
      body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
    });
    let parsed = null;
    try {
      parsed = result.body ? JSON.parse(result.body) : null;
    } catch {
      parsed = { error: result.body };
    }
    if (result.status >= 400) {
      throw new Error(parsed?.error || `服务请求失败（HTTP ${result.status}）`);
    }
    return parsed;
  }

  function applyTheme(theme) {
    const tokens = theme?.tokens;
    if (!tokens) return;
    const root = document.documentElement.style;
    const map = {
      '--bg': tokens.background,
      '--elevated': tokens.elevated,
      '--fg': tokens.foreground,
      '--muted': tokens.muted,
      '--border': tokens.border,
      '--primary': tokens.primary,
      '--primary-fg': tokens.primaryForeground,
      '--success': tokens.success,
      '--warning': tokens.warning,
      '--error': tokens.error,
      '--radius': tokens.radius,
      '--font': tokens.font,
    };
    for (const [k, v] of Object.entries(map)) {
      if (v) root.setProperty(k, v);
    }
  }

  function showError(msg) {
    if (!msg) {
      els.errorText.textContent = '';
      els.errorText.classList.add('hidden');
      return;
    }
    els.errorText.textContent = msg;
    els.errorText.classList.remove('hidden');
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function formatReset(resetAt) {
    if (!resetAt || !Number.isFinite(resetAt)) return '';
    const diffMs = resetAt - Date.now();
    if (diffMs <= 0) return '即将重置';
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) return `${mins} 分钟后重置`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `${hours}h${remMins > 0 ? ` ${remMins}m` : ''} 后重置`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d${remHours > 0 ? ` ${remHours}h` : ''} 后重置`;
  }

  function renderQuota(preview) {
    const windows = preview?.usage?.windows ? Object.entries(preview.usage.windows) : [];
    if (!preview?.configured || windows.length === 0) {
      els.quotaCard.classList.add('hidden');
      return;
    }
    els.quotaCard.classList.remove('hidden');
    if (preview.planLabel) {
      els.planBadge.textContent = preview.planLabel;
      els.planBadge.classList.remove('hidden');
    } else {
      els.planBadge.classList.add('hidden');
    }
    els.quotaList.innerHTML = '';
    for (const [name, win] of windows) {
      const used = typeof win.usedPercent === 'number' ? Math.max(0, Math.min(100, win.usedPercent)) : 0;
      const item = document.createElement('div');
      item.className = 'quota-item';

      const head = document.createElement('div');
      head.className = 'quota-head';
      const label = document.createElement('span');
      label.textContent = name;
      const right = document.createElement('span');
      const resetText = formatReset(win.resetAt);
      right.textContent = resetText ? `已用 ${used}% · ${resetText}` : `已用 ${used}%`;
      right.style.color = 'var(--muted)';
      head.append(label, right);

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      if (used >= 90) fill.classList.add('err');
      else if (used >= 70) fill.classList.add('warn');
      fill.style.width = `${used}%`;
      track.append(fill);

      item.append(head, track);
      els.quotaList.append(item);
    }
  }

  function renderStatus(status) {
    const connected = Boolean(status?.connected);
    currentAuthUrl = status?.pendingAuth?.authUrl || '';

    if (connected) {
      stopPolling();
      els.statusBadge.textContent = '已连接';
      els.statusBadge.className = 'badge ok';
      const label = status.email || 'Google 账号';
      els.accountDesc.textContent = `当前账号：${label}（扩展独立只读 OAuth，不影响 OpenCode / agy-router）`;
      els.loginBtn.classList.add('hidden');
      els.pendingBox.classList.add('hidden');
      els.refreshBtn.classList.remove('hidden');
      els.logoutBtn.classList.remove('hidden');
    } else if (currentAuthUrl) {
      els.statusBadge.textContent = '等待授权…';
      els.statusBadge.className = 'badge warn';
      els.accountDesc.textContent = '请在浏览器完成 Google 登录授权，完成后页面会自动更新。';
      els.loginBtn.classList.remove('hidden');
      els.loginBtn.textContent = '重新发起登录';
      els.pendingBox.classList.remove('hidden');
      els.refreshBtn.classList.add('hidden');
      els.logoutBtn.classList.add('hidden');
      els.quotaCard.classList.add('hidden');
    } else {
      els.statusBadge.textContent = '未连接';
      els.statusBadge.className = 'badge';
      els.accountDesc.textContent = '使用扩展自带的独立 Google OAuth 只读拉取配额，不修改 OpenCode 配置或模型列表。';
      els.loginBtn.classList.remove('hidden');
      els.loginBtn.textContent = '使用 Google 登录';
      els.pendingBox.classList.add('hidden');
      els.refreshBtn.classList.add('hidden');
      els.logoutBtn.classList.add('hidden');
      els.quotaCard.classList.add('hidden');
    }

    if (status?.lastError) {
      showError(status.lastError);
    }
  }

  async function refreshAll() {
    showError('');
    const status = await serviceJson('GET', '/auth/status');
    renderStatus(status);
    if (status.connected) {
      const preview = await serviceJson('GET', '/quota/preview');
      if (preview?.error) showError(preview.error);
      renderQuota(preview);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const status = await serviceJson('GET', '/auth/status');
        renderStatus(status);
        if (status.connected) {
          stopPolling();
          await refreshAll();
          await callHost('toast', { kind: 'success', message: 'Agy CLI Google 账号已授权连接' }).catch(() => {});
        }
      } catch {
        // Ignore transient poll errors while waiting for callback.
      }
    }, 1500);
  }

  els.loginBtn.addEventListener('click', async () => {
    showError('');
    els.loginBtn.disabled = true;
    try {
      const status = await serviceJson('POST', '/auth/start', {});
      renderStatus(status);
      if (status?.pendingAuth?.authUrl) {
        currentAuthUrl = status.pendingAuth.authUrl;
        await callHost('open-url', { url: currentAuthUrl }).catch(() => {});
        startPolling();
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      els.loginBtn.disabled = false;
    }
  });

  els.openUrlBtn.addEventListener('click', () => {
    if (currentAuthUrl) {
      callHost('open-url', { url: currentAuthUrl }).catch((err) => {
        showError(err instanceof Error ? err.message : String(err));
      });
    }
  });

  els.copyUrlBtn.addEventListener('click', async () => {
    if (!currentAuthUrl) return;
    try {
      await callHost('clipboard-write', { text: currentAuthUrl });
      await callHost('toast', { kind: 'info', message: '已复制 Google 授权链接' }).catch(() => {});
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  els.manualSubmitBtn.addEventListener('click', async () => {
    const raw = els.manualInput.value.trim();
    if (!raw) return;
    showError('');
    els.manualSubmitBtn.disabled = true;
    try {
      await serviceJson('POST', '/auth/manual', { input: raw });
      els.manualInput.value = '';
      await refreshAll();
      await callHost('toast', { kind: 'success', message: 'Agy CLI Google 账号已授权连接' }).catch(() => {});
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      els.manualSubmitBtn.disabled = false;
    }
  });

  els.refreshBtn.addEventListener('click', async () => {
    els.refreshBtn.disabled = true;
    try {
      await refreshAll();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      els.refreshBtn.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    els.logoutBtn.disabled = true;
    try {
      stopPolling();
      await serviceJson('POST', '/auth/logout', {});
      await refreshAll();
      await callHost('toast', { kind: 'info', message: '已退出 Agy CLI 用量账号' }).catch(() => {});
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      els.logoutBtn.disabled = false;
    }
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.v !== VERSION) return;
    if (data.type === 'ready') {
      applyTheme(data.payload?.theme);
      refreshAll().catch((err) => {
        showError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    if (data.type === 'result' && data.id) {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.payload);
      else entry.reject(new Error(data.error || data.code || '请求被宿主拒绝'));
    }
  });

  postToHost({ channel: CHANNEL, v: VERSION, type: 'hello' });
})();
