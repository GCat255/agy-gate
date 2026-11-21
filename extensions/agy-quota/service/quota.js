import os from 'node:os';

export const ANTIGRAVITY_CLIENT_VERSION = '2.24.0';
export const DEFAULT_ANTIGRAVITY_PROJECT_ID = 'rising-fact-p41fc';
export const ANTIGRAVITY_ENDPOINTS = Object.freeze([
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]);

function getOsArchLabel() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'win32') return 'windows/amd64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin/arm64' : 'darwin/amd64';
  return 'linux/amd64';
}

export function getAntigravityHeaders() {
  return {
    'User-Agent': `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${getOsArchLabel()}`,
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  };
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseResetTimestamp(resetTime) {
  if (typeof resetTime === 'number' && Number.isFinite(resetTime)) {
    return resetTime > 1e12 ? resetTime : resetTime * 1000;
  }
  if (typeof resetTime === 'string' && resetTime.trim()) {
    const parsed = Date.parse(resetTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inferWindowSeconds(windowKey) {
  const lower = String(windowKey ?? '').toLowerCase();
  if (lower.includes('5h') || lower.includes('5_h') || lower.includes('five')) return 18_000;
  if (lower.includes('week') || lower.includes('7d')) return 604_800;
  if (lower.includes('day') || lower.includes('daily') || lower.includes('24h')) return 86_400;
  return null;
}

function formatBucketLabel(bucket) {
  const raw = String(bucket?.window || bucket?.bucketId || '').trim();
  const lower = raw.toLowerCase();
  if (lower === '5h' || lower.includes('5h')) return '5h';
  if (lower === 'weekly' || lower.includes('week') || lower.includes('7d')) return 'Weekly';
  if (lower === 'daily' || lower.includes('24h')) return 'Daily';
  return raw || 'Quota';
}

function formatGroupLabel(group) {
  const name = String(group?.displayName || group?.groupId || '').trim();
  if (!name) return 'Quota';
  if (/third[\s-]*party|claude/i.test(name)) return 'Claude / 3P';
  if (/gemini/i.test(name)) return 'Gemini';
  return name;
}

async function postAntigravityEndpoint(endpoint, apiPath, accessToken, body, fetchImpl) {
  const res = await fetchImpl(`${endpoint}${apiPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...getAntigravityHeaders(),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function postAcrossEndpoints(endpoints, apiPath, accessToken, body, fetchImpl) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const result = await postAntigravityEndpoint(endpoint, apiPath, accessToken, body, fetchImpl);
      if (result.ok) {
        return result.json;
      }
      lastError = new Error(`${apiPath} 返回 HTTP ${result.status}`);
      if (result.status === 401 || result.status === 403) {
        const authErr = new Error(`Google 接口鉴权失败（HTTP ${result.status}）`);
        authErr.status = result.status;
        throw authErr;
      }
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError || new Error(`所有端点调用 ${apiPath} 均失败`);
}

export async function discoverProjectAndTier(accessToken, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoints = options.endpoints ?? ANTIGRAVITY_ENDPOINTS;
  try {
    const payload = await postAcrossEndpoints(
      endpoints,
      '/v1internal:loadCodeAssist',
      accessToken,
      {
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
        },
      },
      fetchImpl,
    );
    const projectRaw = payload?.cloudaicompanionProject;
    const projectId =
      typeof projectRaw === 'string' && projectRaw.trim()
        ? projectRaw.trim()
        : typeof projectRaw?.id === 'string' && projectRaw.id.trim()
          ? projectRaw.id.trim()
          : DEFAULT_ANTIGRAVITY_PROJECT_ID;
    const planLabel =
      payload?.paidTier?.name
      || payload?.paidTier?.id
      || payload?.currentTier?.name
      || payload?.currentTier?.id
      || null;
    return {
      projectId,
      planLabel: typeof planLabel === 'string' && planLabel.trim() ? planLabel.trim() : null,
    };
  } catch {
    return {
      projectId: DEFAULT_ANTIGRAVITY_PROJECT_ID,
      planLabel: null,
    };
  }
}

export function transformQuotaPayloads({ summaryPayload, modelsPayload, planLabel = null }) {
  const windows = {};
  const groups = Array.isArray(summaryPayload?.groups) ? summaryPayload.groups : [];

  for (const group of groups) {
    const groupLabel = formatGroupLabel(group);
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (typeof bucket?.remainingFraction !== 'number') continue;
      const usedPercent = clampPercent((1 - bucket.remainingFraction) * 100);
      if (usedPercent === null) continue;
      const bucketLabel = formatBucketLabel(bucket);
      const key = `${groupLabel} (${bucketLabel})`;
      windows[key] = {
        usedPercent,
        windowSeconds: inferWindowSeconds(bucket.window || bucket.bucketId),
        resetAt: parseResetTimestamp(bucket.resetTime),
        valueLabel: null,
      };
    }
  }

  const models = {};
  const rawModels = modelsPayload?.models && typeof modelsPayload.models === 'object' ? modelsPayload.models : {};
  for (const [modelId, info] of Object.entries(rawModels)) {
    const remainingFraction = info?.quotaInfo?.remainingFraction;
    if (typeof remainingFraction !== 'number') continue;
    const usedPercent = clampPercent((1 - remainingFraction) * 100);
    if (usedPercent === null) continue;
    const resetAt = parseResetTimestamp(info?.quotaInfo?.resetTime);
    const displayName = typeof info?.displayName === 'string' && info.displayName.trim()
      ? info.displayName.trim()
      : modelId;
    const windowEntry = {
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel: null,
    };
    models[modelId] = {
      windows: {
        [displayName]: windowEntry,
      },
    };
  }

  // Fallback synthesis when retrieveUserQuotaSummary is empty but per-model quotas exist.
  if (Object.keys(windows).length === 0 && Object.keys(models).length > 0) {
    let geminiWorst = null;
    let thirdPartyWorst = null;
    for (const [modelId, entry] of Object.entries(models)) {
      const win = Object.values(entry.windows)[0];
      if (!win || typeof win.usedPercent !== 'number') continue;
      const lower = modelId.toLowerCase();
      if (lower.includes('gemini')) {
        if (!geminiWorst || win.usedPercent > geminiWorst.usedPercent) {
          geminiWorst = win;
        }
      } else if (lower.includes('claude') || lower.includes('gpt') || lower.includes('oss')) {
        if (!thirdPartyWorst || win.usedPercent > thirdPartyWorst.usedPercent) {
          thirdPartyWorst = win;
        }
      }
    }
    if (geminiWorst) windows['Gemini'] = geminiWorst;
    if (thirdPartyWorst) windows['Claude / 3P'] = thirdPartyWorst;
  }

  return {
    ok: true,
    configured: true,
    planLabel: planLabel ?? null,
    usage: {
      windows,
      ...(Object.keys(models).length > 0 ? { models } : {}),
    },
  };
}

export async function readAntigravityQuota(oauthManager, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoints = options.endpoints ?? ANTIGRAVITY_ENDPOINTS;

  let tokenState = null;
  try {
    tokenState = await oauthManager.getAccessToken();
  } catch (error) {
    return {
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
      usage: null,
    };
  }

  if (!tokenState?.accessToken) {
    return {
      ok: false,
      configured: false,
      error: '尚未连接 Google 账号，请点击左侧栏「Agy CLI 用量」完成授权。',
      usage: null,
    };
  }

  const runFetch = async (accessToken, authRecord) => {
    let projectId = authRecord?.projectId || null;
    let planLabel = authRecord?.planLabel || null;
    if (!projectId) {
      const discovered = await discoverProjectAndTier(accessToken, { fetchImpl, endpoints });
      projectId = discovered.projectId;
      planLabel = discovered.planLabel ?? planLabel;
      await oauthManager.updateMetadata({ projectId, planLabel }).catch(() => {});
    }
    const requestBody = projectId ? { project: projectId } : {};
    const [summaryResult, modelsResult] = await Promise.allSettled([
      postAcrossEndpoints(endpoints, '/v1internal:retrieveUserQuotaSummary', accessToken, requestBody, fetchImpl),
      postAcrossEndpoints(endpoints, '/v1internal:fetchAvailableModels', accessToken, requestBody, fetchImpl),
    ]);

    const summaryPayload = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    const modelsPayload = modelsResult.status === 'fulfilled' ? modelsResult.value : null;

    if (!summaryPayload && !modelsPayload) {
      const firstErr =
        (summaryResult.status === 'rejected' && summaryResult.reason)
        || (modelsResult.status === 'rejected' && modelsResult.reason)
        || new Error('无法从 Antigravity 接口获取用量。');
      throw firstErr;
    }

    return transformQuotaPayloads({
      summaryPayload,
      modelsPayload,
      planLabel: planLabel || authRecord?.email || null,
    });
  };

  try {
    return await runFetch(tokenState.accessToken, tokenState.auth);
  } catch (error) {
    if (error && (error.status === 401 || error.status === 403)) {
      try {
        const refreshed = await oauthManager.getAccessToken({ forceRefresh: true });
        if (refreshed?.accessToken) {
          return await runFetch(refreshed.accessToken, refreshed.auth);
        }
      } catch (retryError) {
        return {
          ok: false,
          configured: true,
          error: retryError instanceof Error ? retryError.message : String(retryError),
          usage: null,
        };
      }
    }
    return {
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
      usage: null,
    };
  }
}
