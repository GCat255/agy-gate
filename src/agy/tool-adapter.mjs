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

function buildEditDiff(filePath, oldText, newText) {
  if (typeof oldText !== 'string' && typeof newText !== 'string') return '';
  const safePath = String(filePath || 'file').replace(/\\/g, '/');
  const oldLines = typeof oldText === 'string' ? oldText.split(/\r?\n/) : [];
  const newLines = typeof newText === 'string' ? newText.split(/\r?\n/) : [];
  const body = [
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ];
  return body.join('\n');
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

/**
 * Extract tool output text, metadata (e.g., edit diffs), and inline file/image attachments
 * from an ACP terminal `tool_call_update` payload.
 * @param {any} update
 * @param {{ name: string, rawName?: string, input?: any, isImageRead?: boolean, targetPath?: string }} normalizedTool
 */
export function buildAcpToolResult(update, normalizedTool) {
  const texts = [];
  const diffs = [];
  const files = [];

  const rawOutput = update?.rawOutput;
  if (typeof rawOutput === 'string' && rawOutput.trim()) {
    texts.push(rawOutput);
  } else if (rawOutput && typeof rawOutput === 'object') {
    if (typeof rawOutput.output === 'string' && rawOutput.output.trim()) texts.push(rawOutput.output);
    else if (typeof rawOutput.text === 'string' && rawOutput.text.trim()) texts.push(rawOutput.text);
    else {
      try {
        texts.push(JSON.stringify(rawOutput, null, 2));
      } catch {
        texts.push(String(rawOutput));
      }
    }
  }

  const acpContent = Array.isArray(update?.content) ? update.content : [];
  for (const item of acpContent) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'diff') {
      const diffPath = item.path || normalizedTool.targetPath || normalizedTool.input?.path;
      const diffText = buildEditDiff(diffPath, item.oldText, item.newText);
      if (diffText) diffs.push({ path: diffPath, patch: diffText });
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
    if (typeof item.text === 'string' && item.text.trim()) {
      texts.push(item.text);
    } else if (typeof item.content?.text === 'string' && item.content.text.trim()) {
      texts.push(item.content.text);
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
      ? { filediff: { patch: diffs[0].patch, file: diffs[0].path }, diff: diffs[0].patch }
      : { files: diffs.map((d) => ({ filePath: d.path, patch: d.patch })) };
  } else if (
    normalizedTool.name === 'edit' &&
    typeof normalizedTool.input?.oldString === 'string' &&
    typeof normalizedTool.input?.newString === 'string'
  ) {
    const patch = buildEditDiff(normalizedTool.input.path, normalizedTool.input.oldString, normalizedTool.input.newString);
    if (patch) {
      diffMeta = { filediff: { patch, file: normalizedTool.input.path }, diff: patch };
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
