import fs from 'node:fs';
import path from 'node:path';
import { unwrapOpenChamberToolCall } from '../bridge/mcp.mjs';
import { getCachedOpenChamberToolContract } from '../bridge/openchamber.mjs';

const MAX_INLINE_IMAGE_BYTES = 1024 * 1024; // 1 MiB safety cap to keep SSE & session JSON bounded
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/**
 * Unwrap JSON-stringified scalar/array/object parameter values sometimes emitted by `agy`.
 * @param {any} val
 */
export function unwrapToolParamValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}

function pickValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const val = unwrapToolParamValue(obj[key]);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function pickString(obj, keys) {
  const val = pickValue(obj, keys);
  if (typeof val === 'string') return val.trim() ? val : undefined;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return undefined;
}

function pickNumber(obj, keys) {
  const val = pickValue(obj, keys);
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const n = Number(val.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstLine(text, maxLen = 100) {
  if (typeof text !== 'string') return '';
  const line = text.trim().split(/\r?\n/)[0]?.trim() || '';
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

function inferImageMime(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const ext = path.extname(filePath.trim()).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || null;
}

function pickAcpLocationPath(update) {
  const locs = Array.isArray(update?.locations) ? update.locations : [];
  for (const loc of locs) {
    if (typeof loc?.path === 'string' && loc.path.trim()) return loc.path.trim();
  }
  return undefined;
}

function resolveCanonicalToolName(roleKey, fallbackName, contract) {
  const roles = contract?.semanticRoles || {};
  const tools = contract?.canonicalTools || {};
  const candidate = roles[roleKey] || fallbackName;
  if (tools[candidate]) return candidate;
  if (tools[fallbackName]) return fallbackName;
  return candidate;
}

const DIFF_CONTEXT_LINES = 3;
const MAX_MYERS_CELLS = 2_500_000;
const MAX_MYERS_D = 2000;

function computeLineEditOps(oldMid, newMid) {
  const n = oldMid.length;
  const m = newMid.length;
  if (n === 0) return newMid.map((line) => ({ op: '+', line }));
  if (m === 0) return oldMid.map((line) => ({ op: '-', line }));

  // Myers shortest edit script over trimmed middle slice; falls back to block replace on huge rewrites.
  if (n * m <= MAX_MYERS_CELLS) {
    const maxD = Math.min(MAX_MYERS_D, n + m);
    const offset = maxD;
    const v = new Int32Array(2 * maxD + 1);
    const trace = [];
    for (let d = 0; d <= maxD; d += 1) {
      trace.push(new Int32Array(v));
      for (let k = -d; k <= d; k += 2) {
        const idx = k + offset;
        let x;
        if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
          x = v[idx + 1];
        } else {
          x = v[idx - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && oldMid[x] === newMid[y]) {
          x += 1;
          y += 1;
        }
        v[idx] = x;
        if (x >= n && y >= m) {
          const ops = [];
          let curX = n;
          let curY = m;
          for (let step = d; step > 0; step -= 1) {
            const prevV = trace[step];
            const kCur = curX - curY;
            const kIdx = kCur + offset;
            const moveDown = kCur === -step || (kCur !== step && prevV[kIdx - 1] < prevV[kIdx + 1]);
            const prevK = moveDown ? kCur + 1 : kCur - 1;
            const prevX = prevV[prevK + offset];
            const prevY = prevX - prevK;
            while (curX > prevX && curY > prevY) {
              curX -= 1;
              curY -= 1;
              ops.push({ op: ' ', line: oldMid[curX] });
            }
            if (moveDown) {
              curY -= 1;
              ops.push({ op: '+', line: newMid[curY] });
            } else {
              curX -= 1;
              ops.push({ op: '-', line: oldMid[curX] });
            }
          }
          while (curX > 0 && curY > 0) {
            curX -= 1;
            curY -= 1;
            ops.push({ op: ' ', line: oldMid[curX] });
          }
          ops.reverse();
          return ops;
        }
      }
    }
  }

  return [
    ...oldMid.map((line) => ({ op: '-', line })),
    ...newMid.map((line) => ({ op: '+', line })),
  ];
}

function buildEditDiff(filePath, oldText, newText) {
  if (typeof oldText !== 'string' && typeof newText !== 'string') return '';
  const hasOld = typeof oldText === 'string';
  const hasNew = typeof newText === 'string';
  if (hasOld && hasNew && oldText === newText) return '';

  const safePath = String(filePath || 'file').replace(/\\/g, '/');
  const oldLines = hasOld && oldText.length > 0 ? oldText.replace(/\r\n/g, '\n').split('\n') : [];
  const newLines = hasNew && newText.length > 0 ? newText.replace(/\r\n/g, '\n').split('\n') : [];

  if (oldLines.length === 0 && newLines.length === 0) return '';
  if (oldLines.length === 0) {
    return {
      patch: [
        '--- /dev/null',
        `+++ b/${safePath}`,
        `@@ -0,0 +1,${newLines.length} @@`,
        ...newLines.map((l) => `+${l}`),
      ].join('\n'),
      additions: newLines.length,
      deletions: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      patch: [
        `--- a/${safePath}`,
        '+++ /dev/null',
        `@@ -1,${oldLines.length} +0,0 @@`,
        ...oldLines.map((l) => `-${l}`),
      ].join('\n'),
      additions: 0,
      deletions: oldLines.length,
    };
  }

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix + suffix >= oldLines.length && prefix + suffix >= newLines.length) {
    return '';
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const midOps = computeLineEditOps(oldMid, newMid);

  // Reconstruct full op list only across [prefixStart .. midEnd + context] with exact 1-based line coordinates
  const fullOps = [];
  for (let i = 0; i < prefix; i += 1) {
    fullOps.push({ op: ' ', line: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }
  let oldCursor = prefix + 1;
  let newCursor = prefix + 1;
  for (const item of midOps) {
    if (item.op === ' ') {
      fullOps.push({ op: ' ', line: item.line, oldLine: oldCursor, newLine: newCursor });
      oldCursor += 1;
      newCursor += 1;
    } else if (item.op === '-') {
      fullOps.push({ op: '-', line: item.line, oldLine: oldCursor, newLine: newCursor });
      oldCursor += 1;
    } else {
      fullOps.push({ op: '+', line: item.line, oldLine: oldCursor, newLine: newCursor });
      newCursor += 1;
    }
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    fullOps.push({ op: ' ', line: oldLines[i], oldLine: oldCursor, newLine: newCursor });
    oldCursor += 1;
    newCursor += 1;
  }

  // Build unified hunks grouping nearby changes within 2 * DIFF_CONTEXT_LINES
  const changeIndices = [];
  for (let i = 0; i < fullOps.length; i += 1) {
    if (fullOps[i].op !== ' ') changeIndices.push(i);
  }
  if (changeIndices.length === 0) return '';

  const hunkLines = [`--- a/${safePath}`, `+++ b/${safePath}`];
  let additions = 0;
  let deletions = 0;
  let groupStart = 0;

  while (groupStart < changeIndices.length) {
    const startIdx = Math.max(0, changeIndices[groupStart] - DIFF_CONTEXT_LINES);
    let groupEnd = groupStart;
    while (
      groupEnd + 1 < changeIndices.length &&
      changeIndices[groupEnd + 1] - changeIndices[groupEnd] <= DIFF_CONTEXT_LINES * 2 + 1
    ) {
      groupEnd += 1;
    }
    const endIdx = Math.min(fullOps.length - 1, changeIndices[groupEnd] + DIFF_CONTEXT_LINES);

    let oldCount = 0;
    let newCount = 0;
    let firstOld = null;
    let firstNew = null;
    const lines = [];
    for (let i = startIdx; i <= endIdx; i += 1) {
      const entry = fullOps[i];
      if (entry.op === ' ') {
        if (firstOld === null) firstOld = entry.oldLine;
        if (firstNew === null) firstNew = entry.newLine;
        oldCount += 1;
        newCount += 1;
        lines.push(` ${entry.line}`);
      } else if (entry.op === '-') {
        if (firstOld === null) firstOld = entry.oldLine;
        if (firstNew === null) firstNew = entry.newLine;
        oldCount += 1;
        deletions += 1;
        lines.push(`-${entry.line}`);
      } else {
        if (firstOld === null) firstOld = entry.oldLine;
        if (firstNew === null) firstNew = entry.newLine;
        newCount += 1;
        additions += 1;
        lines.push(`+${entry.line}`);
      }
    }

    const headerOldStart = oldCount === 0 ? Math.max(0, (firstOld ?? 1) - 1) : (firstOld ?? 1);
    const headerNewStart = newCount === 0 ? Math.max(0, (firstNew ?? 1) - 1) : (firstNew ?? 1);
    hunkLines.push(`@@ -${headerOldStart},${oldCount} +${headerNewStart},${newCount} @@`);
    hunkLines.push(...lines);
    groupStart = groupEnd + 1;
  }

  return {
    patch: hunkLines.join('\n'),
    additions,
    deletions,
  };
}

function buildInlineImageFileItem(filePath) {
  const mime = inferImageMime(filePath);
  if (!mime) return null;
  try {
    const cleanPath = /^\/[A-Za-z]:\//.test(filePath) ? filePath.slice(1) : filePath;
    const stat = fs.statSync(cleanPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INLINE_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(cleanPath);
    return {
      type: 'file',
      mime,
      name: path.basename(cleanPath),
      uri: `data:${mime};base64,${buf.toString('base64')}`,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function summarizeMcpArgs(toolName, args) {
  const parts = [];
  const action = pickString(args, ['action', 'Action', 'operation', 'op', 'method']);
  if (action) parts.push(action);
  const detail = pickString(args, [
    'path',
    'Path',
    'filePath',
    'uri',
    'Uri',
    'url',
    'Url',
    'query',
    'Query',
    'name',
    'Name',
    'target',
    'code',
    'command',
  ]);
  if (detail) {
    parts.push(firstLine(detail, 72));
  }
  if (parts.length > 0) return parts.join(' · ');
  return toolName;
}

/**
 * Declarative adapter registry converting `agy` / ACP tools into OpenChamber/OpenCode's
 * canonical tool contract while keeping future OP & `agy` tool evolution clean and localized.
 */
const BUILTIN_ADAPTERS = [
  {
    names: new Set(['read_file', 'view_file', 'read']),
    normalize({ rawInput, acpPath, contract }) {
      const targetPath = pickString(rawInput, ['path', 'Path', 'filePath', 'file_path', 'TargetFile', 'AbsolutePath']) || acpPath;
      const startLine = pickNumber(rawInput, ['offset', 'StartLine', 'start_line']);
      const endLine = pickNumber(rawInput, ['EndLine', 'end_line']);
      const explicitLimit = pickNumber(rawInput, ['limit']);
      const limit = explicitLimit !== undefined
        ? explicitLimit
        : startLine !== undefined && endLine !== undefined && endLine >= startLine
          ? endLine - startLine + 1
          : undefined;

      const input = {
        ...(targetPath ? { path: targetPath } : {}),
        ...(startLine !== undefined ? { offset: startLine } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      return {
        name: resolveCanonicalToolName('read', 'read', contract),
        input,
        isImageRead: Boolean(targetPath && inferImageMime(targetPath)),
        targetPath,
      };
    },
  },
  {
    names: new Set(['write_file', 'write_to_file', 'write']),
    normalize({ rawInput, acpPath, contract }) {
      const targetPath = pickString(rawInput, ['path', 'Path', 'TargetFile', 'filePath', 'file_path', 'AbsolutePath']) || acpPath;
      const content = pickValue(rawInput, ['content', 'Content', 'CodeContent']);
      const input = {
        ...(targetPath ? { path: targetPath } : {}),
        ...(typeof content === 'string' ? { content } : {}),
      };
      return {
        name: resolveCanonicalToolName('write', 'write', contract),
        input,
        targetPath,
      };
    },
  },
  {
    names: new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content', 'edit']),
    normalize({ rawInput, acpPath, contract }) {
      const targetPath = pickString(rawInput, ['path', 'Path', 'TargetFile', 'filePath', 'file_path', 'AbsolutePath']) || acpPath;
      let oldString = pickValue(rawInput, ['oldString', 'old_string', 'Target', 'TargetContent']);
      let newString = pickValue(rawInput, ['newString', 'new_string', 'Replacement', 'ReplacementContent']);
      const chunks = Array.isArray(rawInput?.ReplacementChunks) ? rawInput.ReplacementChunks : null;
      if (chunks && chunks.length > 0 && typeof oldString !== 'string' && typeof newString !== 'string') {
        oldString = chunks.map((c) => String(c?.TargetContent ?? '')).join('\n...\n');
        newString = chunks.map((c) => String(c?.ReplacementContent ?? '')).join('\n...\n');
      }
      const input = {
        ...(targetPath ? { path: targetPath } : {}),
        ...(typeof oldString === 'string' ? { oldString } : {}),
        ...(typeof newString === 'string' ? { newString } : {}),
      };
      return {
        name: resolveCanonicalToolName('edit', 'edit', contract),
        input,
        targetPath,
      };
    },
  },
  {
    names: new Set(['run_command', 'execute_command', 'shell', 'bash']),
    normalize({ rawInput, acpTitle, contract }) {
      const command = pickString(rawInput, ['command', 'CommandLine', 'Command', 'cmd']);
      const description = pickString(rawInput, ['description', 'toolSummary', 'Description']) || firstLine(acpTitle);
      const timeout = pickNumber(rawInput, ['timeout', 'WaitMsBeforeAsync']);
      const input = {
        ...(command ? { command } : {}),
        ...(description ? { description } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
      return {
        name: resolveCanonicalToolName('shell', 'shell', contract),
        input,
      };
    },
  },
  {
    names: new Set(['grep_search', 'grep']),
    normalize({ rawInput, acpPath, contract }) {
      const pattern = pickString(rawInput, ['pattern', 'Query', 'Pattern', 'query']);
      const searchPath = pickString(rawInput, ['path', 'SearchPath', 'Directory', 'Path']) || acpPath;
      return {
        name: resolveCanonicalToolName('grep', 'grep', contract),
        input: {
          ...(pattern ? { pattern } : {}),
          ...(searchPath ? { path: searchPath } : {}),
        },
      };
    },
  },
  {
    names: new Set(['find_by_name', 'list_dir', 'glob']),
    normalize({ rawName, rawInput, acpPath, contract }) {
      const rawPattern = pickString(rawInput, ['pattern', 'Pattern']);
      const pattern = rawPattern || (rawName === 'list_dir' ? '*' : undefined);
      const searchPath =
        pickString(rawInput, ['path', 'SearchDirectory', 'DirectoryPath', 'Path']) || acpPath;
      return {
        name: resolveCanonicalToolName('glob', 'glob', contract),
        input: {
          ...(pattern ? { pattern } : {}),
          ...(searchPath ? { path: searchPath } : {}),
        },
      };
    },
  },
  {
    names: new Set(['read_url_content', 'webfetch']),
    normalize({ rawInput, contract }) {
      const url = pickString(rawInput, ['url', 'Url']);
      return {
        name: resolveCanonicalToolName('webfetch', 'webfetch', contract),
        input: url ? { url } : {},
      };
    },
  },
  {
    names: new Set(['search_web', 'websearch']),
    normalize({ rawInput, contract }) {
      const query = pickString(rawInput, ['query', 'Query']);
      return {
        name: resolveCanonicalToolName('websearch', 'websearch', contract),
        input: query ? { query } : {},
      };
    },
  },
];

const ADAPTER_BY_NAME = new Map();
for (const adapter of BUILTIN_ADAPTERS) {
  for (const name of adapter.names) {
    ADAPTER_BY_NAME.set(name, adapter);
  }
}

/**
 * Merge progressive ACP `tool_call` / `tool_call_update` payloads so partial initial updates
 * retain fields added later while in-progress or on completion.
 * @param {any} prev
 * @param {any} update
 */
export function mergeAcpToolSnapshot(prev, update) {
  const nextRawInput = update?.rawInput && typeof update.rawInput === 'object'
    ? update.rawInput
    : update?.args && typeof update.args === 'object'
      ? update.args
      : {};
  const nextLocations = Array.isArray(update?.locations) && update.locations.length > 0
    ? update.locations
    : prev?.locations || [];

  return {
    name: update?.name || prev?.name || 'tool',
    kind: update?.kind || prev?.kind || '',
    title: update?.title || prev?.title || '',
    locations: nextLocations,
    rawInput: { ...(prev?.rawInput || {}), ...nextRawInput },
  };
}

/**
 * Normalize an ACP tool snapshot against the active OpenChamber tool contract.
 * @param {any} snapshot
 * @param {{ contract?: any }} [options]
 */
export function normalizeAcpToolInvocation(snapshot, options = {}) {
  const contract = options.contract || getCachedOpenChamberToolContract();
  const rawName = String(snapshot?.name || 'tool').trim() || 'tool';
  const rawInput = snapshot?.rawInput && typeof snapshot.rawInput === 'object' ? snapshot.rawInput : {};
  const acpPath = pickAcpLocationPath(snapshot);
  const acpTitle = typeof snapshot?.title === 'string' ? snapshot.title.trim() : '';

  // 1. OpenChamber's own MCP tools stay canonical (`openchamber_*`)
  const unwrappedOc = unwrapOpenChamberToolCall(rawName, rawInput);
  if (unwrappedOc.isOpenChamberTool) {
    return {
      rawName,
      name: unwrappedOc.name,
      input: unwrappedOc.input,
      isOpenChamberTool: true,
      isImageRead: false,
      targetPath: undefined,
    };
  }

  // 2. Generic MCP tool wrapper (`call_mcp_tool`)
  if (rawName === 'call_mcp_tool') {
    const serverName = pickString(rawInput, ['ServerName', 'serverName', 'server']);
    const toolName = pickString(rawInput, ['ToolName', 'toolName', 'tool']);
    const args = pickValue(rawInput, ['Arguments', 'arguments', 'args']);
    const argObj = args && typeof args === 'object' ? args : {};
    const displayTool = serverName && toolName
      ? `${serverName}/${toolName}`
      : toolName || serverName || rawName;
    const description = summarizeMcpArgs(toolName || displayTool, argObj);

    return {
      rawName,
      name: displayTool,
      input: {
        ...(Object.keys(argObj).length > 0 ? argObj : rawInput),
        ...(serverName ? { server: serverName } : {}),
        ...(toolName ? { tool: toolName } : {}),
        description,
      },
      isOpenChamberTool: false,
      isImageRead: false,
      targetPath: pickString(argObj, ['path', 'Path', 'filePath']),
    };
  }

  // 3. Built-in `agy` -> canonical OpenCode/OpenChamber tool registry
  const adapter = ADAPTER_BY_NAME.get(rawName);
  if (adapter) {
    const mapped = adapter.normalize({
      rawName,
      rawInput,
      acpPath,
      acpTitle,
      contract,
    });
    return {
      rawName,
      name: mapped.name,
      input: mapped.input,
      isOpenChamberTool: false,
      isImageRead: Boolean(mapped.isImageRead),
      targetPath: mapped.targetPath,
    };
  }

  // 4. Special `agy` resource & control tools (keep raw fields + inject `description` for UI subtitle)
  if (rawName === 'read_resource' || rawName === 'list_resources') {
    const server = pickString(rawInput, ['ServerName', 'server']);
    const uri = pickString(rawInput, ['Uri', 'uri']);
    const desc = [server, uri].filter(Boolean).join(' · ') || acpTitle;
    return {
      rawName,
      name: rawName,
      input: {
        ...rawInput,
        ...(desc ? { description: desc } : {}),
      },
      isOpenChamberTool: false,
      isImageRead: false,
      targetPath: undefined,
    };
  }

  if (rawName === 'send_message' || rawName === 'manage_subagents' || rawName === 'schedule' || rawName === 'manage_task') {
    const summary = rawName === 'send_message'
      ? [pickString(rawInput, ['Recipient', 'recipient']), firstLine(pickString(rawInput, ['Message', 'message']), 60)]
        .filter(Boolean)
        .join(' · ')
      : rawName === 'manage_subagents'
        ? [pickString(rawInput, ['Action', 'action']), Array.isArray(rawInput.ConversationIds) ? rawInput.ConversationIds.join(', ') : '']
          .filter(Boolean)
          .join(' · ')
        : rawName === 'schedule'
          ? firstLine(pickString(rawInput, ['Prompt', 'prompt', 'CronExpression']), 72)
          : pickString(rawInput, ['Action', 'action']);
    return {
      rawName,
      name: rawName,
      input: {
        ...rawInput,
        ...(summary && !rawInput.description ? { description: summary } : {}),
      },
      isOpenChamberTool: false,
      isImageRead: false,
      targetPath: undefined,
    };
  }

  // 5. Future unseen `agy` / MCP tools: derive path/description/image hints from ACP metadata automatically
  const fallbackDesc =
    pickString(rawInput, ['description', 'toolSummary', 'Description', 'query', 'Query', 'url', 'Url', 'prompt', 'Prompt'])
    || firstLine(acpTitle);
  const fallbackPath =
    pickString(rawInput, ['path', 'Path', 'filePath', 'file_path', 'TargetFile']) || acpPath;
  const acpKind = String(snapshot?.kind || '').toLowerCase();

  return {
    rawName,
    name: unwrappedOc.name,
    input: {
      ...rawInput,
      ...(fallbackPath && !rawInput.path ? { path: fallbackPath } : {}),
      ...(fallbackDesc && !rawInput.description ? { description: fallbackDesc } : {}),
    },
    isOpenChamberTool: false,
    isImageRead: Boolean(acpKind === 'read' && fallbackPath && inferImageMime(fallbackPath)),
    targetPath: fallbackPath,
  };
}

function tryParseJsonText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function pushUniqueText(texts, seen, value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  texts.push(value);
}

function unwrapOpenChamberEnvelope(val, depth = 0) {
  if (depth > 4 || val == null) return null;
  if (typeof val === 'string') {
    const parsed = tryParseJsonText(val);
    return parsed ? unwrapOpenChamberEnvelope(parsed, depth + 1) : null;
  }
  if (Array.isArray(val)) {
    for (const entry of val) {
      const found = unwrapOpenChamberEnvelope(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof val !== 'object') return null;
  if (val.schemaVersion === 1 || (typeof val.ok === 'boolean' && (val.action || val.data || val.error))) {
    return val;
  }
  if (typeof val.text === 'string') {
    const found = unwrapOpenChamberEnvelope(val.text, depth + 1);
    if (found) return found;
  }
  if (val.content !== undefined) {
    const found = unwrapOpenChamberEnvelope(val.content, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Extract structured `{ schemaVersion: 1, ok, action, data }` envelope from an ACP OpenChamber tool update,
 * handling duplicate `rawOutput` + `content` payloads and MCP `{ content: [{ type: 'text', text }] }` wrappers.
 * @param {any} update
 * @param {string} [outputText]
 */
export function extractOpenChamberToolPayload(update, outputText) {
  const direct = unwrapOpenChamberEnvelope(update?.rawOutput);
  if (direct) return direct;
  const acpContent = Array.isArray(update?.content) ? update.content : [];
  for (const item of acpContent) {
    const found = unwrapOpenChamberEnvelope(item);
    if (found) return found;
  }
  return unwrapOpenChamberEnvelope(outputText);
}

/**
 * Extract tool output text, metadata (e.g., edit diffs), and inline file/image attachments
 * from an ACP terminal `tool_call_update` payload.
 * @param {any} update
 * @param {{ name: string, rawName?: string, input?: any, isImageRead?: boolean, targetPath?: string }} normalizedTool
 */
export function buildAcpToolResult(update, normalizedTool) {
  const texts = [];
  const seenTexts = new Set();
  const diffs = [];
  const files = [];

  const rawOutput = update?.rawOutput;
  if (typeof rawOutput === 'string') {
    pushUniqueText(texts, seenTexts, rawOutput);
  } else if (rawOutput && typeof rawOutput === 'object') {
    if (typeof rawOutput.output === 'string' && rawOutput.output.trim()) {
      pushUniqueText(texts, seenTexts, rawOutput.output);
    } else if (typeof rawOutput.text === 'string' && rawOutput.text.trim()) {
      pushUniqueText(texts, seenTexts, rawOutput.text);
    } else if (Array.isArray(rawOutput.content) && rawOutput.content.every((c) => c && typeof c.text === 'string')) {
      for (const c of rawOutput.content) {
        pushUniqueText(texts, seenTexts, c.text);
      }
    } else {
      try {
        pushUniqueText(texts, seenTexts, JSON.stringify(rawOutput, null, 2));
      } catch {
        pushUniqueText(texts, seenTexts, String(rawOutput));
      }
    }
  }

  const acpContent = Array.isArray(update?.content) ? update.content : [];
  for (const item of acpContent) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'diff') {
      const diffPath = item.path || normalizedTool.targetPath || normalizedTool.input?.path;
      const diffResult = buildEditDiff(diffPath, item.oldText, item.newText);
      if (diffResult && diffResult.patch) {
        diffs.push({
          path: diffPath,
          patch: diffResult.patch,
          additions: diffResult.additions,
          deletions: diffResult.deletions,
        });
      }
      continue;
    }
    if (item.type === 'image' && typeof item.data === 'string' && item.data) {
      const mime = item.mimeType || item.mime || 'image/png';
      files.push({
        type: 'file',
        mime,
        name: path.basename(normalizedTool.targetPath || 'image.png'),
        uri: `data:${mime};base64,${item.data}`,
      });
      continue;
    }
    if (typeof item.text === 'string') {
      pushUniqueText(texts, seenTexts, item.text);
    } else if (typeof item.content?.text === 'string') {
      pushUniqueText(texts, seenTexts, item.content.text);
    } else if (item.content?.type === 'image' && typeof item.content.data === 'string' && item.content.data) {
      const mime = item.content.mimeType || item.content.mime || 'image/png';
      files.push({
        type: 'file',
        mime,
        name: path.basename(normalizedTool.targetPath || 'image.png'),
        uri: `data:${mime};base64,${item.content.data}`,
      });
    }
  }

  // Fallback for image `read_file`: `agy acp` emits empty content/rawOutput when reading images.
  if (normalizedTool.isImageRead && normalizedTool.targetPath && files.length === 0) {
    const attached = buildInlineImageFileItem(normalizedTool.targetPath);
    if (attached) {
      files.push({
        type: 'file',
        mime: attached.mime,
        name: attached.name,
        uri: attached.uri,
      });
      if (texts.length === 0) {
        texts.push(`Read image: ${normalizedTool.targetPath} (${Math.max(1, Math.round(attached.size / 1024))} KB)`);
      }
    } else if (texts.length === 0) {
      texts.push(`Read image: ${normalizedTool.targetPath}`);
    }
  }

  // Fallback diff metadata for canonical `edit` when ACP omits explicit diff blocks.
  let diffMeta;
  if (diffs.length > 0) {
    diffMeta = diffs.length === 1
      ? {
          filediff: {
            patch: diffs[0].patch,
            file: diffs[0].path,
            additions: diffs[0].additions,
            deletions: diffs[0].deletions,
          },
          diff: diffs[0].patch,
        }
      : {
          files: diffs.map((d) => ({
            filePath: d.path,
            patch: d.patch,
            additions: d.additions,
            deletions: d.deletions,
          })),
        };
  } else if (
    normalizedTool.name === 'edit' &&
    typeof normalizedTool.input?.oldString === 'string' &&
    typeof normalizedTool.input?.newString === 'string'
  ) {
    const diffResult = buildEditDiff(normalizedTool.input.path, normalizedTool.input.oldString, normalizedTool.input.newString);
    if (diffResult && diffResult.patch) {
      diffMeta = {
        filediff: {
          patch: diffResult.patch,
          file: normalizedTool.input.path,
          additions: diffResult.additions,
          deletions: diffResult.deletions,
        },
        diff: diffResult.patch,
      };
    }
  }

  const outputText = texts.join('\n');
  const contentItems = [
    ...(outputText ? [{ type: 'text', text: outputText }] : []),
    ...files,
  ];

  return {
    outputText,
    contentItems,
    diffMeta,
  };
}
