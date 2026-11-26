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
  if (lower.includes('week') || lower.includes('7d')) return 604_800;
  if (lower.includes('day') || lower.includes('daily') || lower.includes('24h')) return 86_400;
  return 18_000;
}

function formatBucketLabel(bucket) {
  const raw = String(bucket?.window || bucket?.bucketId || '').trim();
  const lower = raw.toLowerCase();
  if (lower.includes('week') || lower.includes('7d')) return 'Weekly';
  if (lower.includes('day') || lower.includes('daily') || lower.includes('24h')) return 'Daily';
  if (lower.includes('5h') || lower === '' || lower.includes('five')) return '5h';
  return raw;
}

function formatGroupLabel(group) {
  const name = String(group?.displayName || group?.groupId || '').trim();
  if (!name) return 'Quota';
  if (/third[\s-]*party|claude|gpt|3p/i.test(name)) return 'Claude / GPT';
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

function pickSummaryFallbackBucket(existing, candidate) {
  if (!existing) return candidate;
  if ((candidate.usedPercent ?? -1) > (existing.usedPercent ?? -1)) return candidate;
  return existing;
}

export function transformQuotaPayloads({ summaryPayload, modelsPayload = null, planLabel = null }) {
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

  // Only aggregate into Gemini / Claude / GPT pool summaries when summaryPayload had no buckets.
  if (Object.keys(windows).length === 0) {
    const rawModels = modelsPayload?.models && typeof modelsPayload.models === 'object' ? modelsPayload.models : {};
    let gemini = null;
    let claudeGpt = null;
    for (const [modelId, info] of Object.entries(rawModels)) {
      const remainingFraction = info?.quotaInfo?.remainingFraction;
      if (typeof remainingFraction !== 'number') continue;
      const usedPercent = clampPercent((1 - remainingFraction) * 100);
      if (usedPercent === null) continue;
      const resetAt = parseResetTimestamp(info?.quotaInfo?.resetTime);
      const candidate = {
        usedPercent,
        windowSeconds: 18_000,
        resetAt,
        valueLabel: null,
      };
      const lower = modelId.toLowerCase();
      if (lower.includes('gemini')) {
        gemini = pickSummaryFallbackBucket(gemini, candidate);
      } else if (lower.includes('claude') || lower.includes('gpt')) {
        claudeGpt = pickSummaryFallbackBucket(claudeGpt, candidate);
      }
    }
    if (gemini) windows['Gemini'] = gemini;
    if (claudeGpt) windows['Claude / GPT'] = claudeGpt;
  }

  return {
    ok: true,
    configured: true,
    planLabel: planLabel ?? null,
    usage: {
      windows,
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
      configured: true,
      error: '尚未授权 Google 账号，请运行 occ → Agy 用量授权（或 agy-gate quota-login）。',
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
    let summaryPayload = null;
    let summaryError = null;
    try {
      summaryPayload = await postAcrossEndpoints(
        endpoints,
        '/v1internal:retrieveUserQuotaSummary',
        accessToken,
        requestBody,
        fetchImpl,
      );
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        throw error;
      }
      summaryError = error;
    }

    let modelsPayload = null;
    const hasSummaryBuckets = Array.isArray(summaryPayload?.groups)
      && summaryPayload.groups.some((g) => Array.isArray(g?.buckets) && g.buckets.length > 0);
    if (!hasSummaryBuckets) {
      try {
        modelsPayload = await postAcrossEndpoints(
          endpoints,
          '/v1internal:fetchAvailableModels',
          accessToken,
          requestBody,
          fetchImpl,
        );
      } catch (error) {
        if (error && (error.status === 401 || error.status === 403)) {
          throw error;
        }
        if (!summaryPayload) {
          throw summaryError || error;
        }
      }
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
