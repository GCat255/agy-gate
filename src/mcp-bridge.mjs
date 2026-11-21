import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadOpenChamberToolSpecs } from './openchamber-bridge.mjs';

export const OPENCHAMBER_MCP_NAME = 'openchamber';

/**
 * Known OpenChamber agent tool names (plus prefix stripping for MCP `mcp__openchamber__*` names).
 */
export const OPENCHAMBER_TOOL_NAMES = new Set([
  'openchamber',
  'openchamber_schedule',
  'openchamber_web',
  'openchamber_memory',
  'openchamber_knowledge',
  'openchamber_notify',
  'openchamber_render',
  'openchamber_secret',
  'openchamber_image',
  'openchamber_usage',
  'openchamber_terminal',
  'openchamber_workflow',
]);

/**
 * Unwrap either direct OpenChamber tool name or `agy-cli`'s `call_mcp_tool` wrapper.
 * @param {string} rawName
 * @param {any} rawParams
 * @returns {{ name: string, input: any, isOpenChamberTool: boolean }}
 */
export function unwrapOpenChamberToolCall(rawName, rawParams) {
  const s = String(rawName || '').trim();
  if (
    s === 'call_mcp_tool'
    && rawParams
    && typeof rawParams === 'object'
    && rawParams.ServerName === OPENCHAMBER_MCP_NAME
    && typeof rawParams.ToolName === 'string'
  ) {
    const innerName = normalizeOpenChamberToolName(rawParams.ToolName);
    const innerInput = rawParams.Arguments && typeof rawParams.Arguments === 'object' ? rawParams.Arguments : {};
    return {
      name: innerName,
      input: innerInput,
      isOpenChamberTool: OPENCHAMBER_TOOL_NAMES.has(innerName),
    };
  }
  const normalized = normalizeOpenChamberToolName(s);
  return {
    name: normalized,
    input: rawParams && typeof rawParams === 'object' ? rawParams : {},
    isOpenChamberTool: OPENCHAMBER_TOOL_NAMES.has(normalized),
  };
}

/**
 * Strip `mcp__openchamber__` / `openchamber/` MCP prefixes emitted by `agy-cli` back to canonical OpenChamber tool names.
 * @param {string} rawName
 */
export function normalizeOpenChamberToolName(rawName) {
  const s = String(rawName || '').trim();
  for (const prefix of ['mcp__openchamber__', 'openchamber__', 'openchamber/', 'openchamber:']) {
    if (s.startsWith(prefix)) {
      const bare = s.slice(prefix.length);
      if (OPENCHAMBER_TOOL_NAMES.has(bare)) return bare;
    }
  }
  return s;
}

/**
 * Resolve Gemini/Agy CLI global `mcp_config.json` path without disturbing other configurations.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgyMcpConfigPath(env = process.env) {
  if (env.AGY_MCP_CONFIG_PATH?.trim()) {
    return path.resolve(env.AGY_MCP_CONFIG_PATH.trim());
  }
  return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
}

/**
 * Compute desired `mcpServers.openchamber` entry pointing to this router's `mcp-bridge` command.
 * Uses `mcp-nowindow.exe` on Windows when present so spawning the bridge never flashes a console window.
 * @param {{ cliEntryPath: string, env?: NodeJS.ProcessEnv }} options
 */
export function buildOpenChamberMcpEntry({ cliEntryPath, env = process.env }) {
  const resolvedCli = path.resolve(cliEntryPath);
  const noWindow = process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'mcp-nowindow.exe')
    : null;

  if (noWindow && fs.existsSync(noWindow)) {
    return {
      command: noWindow,
      args: [process.execPath, resolvedCli, 'mcp-bridge'],
      disabled: false,
    };
  }
  return {
    command: process.execPath,
    args: [resolvedCli, 'mcp-bridge'],
    disabled: false,
  };
}

/**
 * Idempotently register or update ONLY `mcpServers.openchamber` inside `~/.gemini/config/mcp_config.json`.
 * Preserves all unrelated MCP servers verbatim.
 * @param {{ cliEntryPath: string, env?: NodeJS.ProcessEnv }} options
 */
export function ensureOpenChamberMcpConfig({ cliEntryPath, env = process.env }) {
  const configPath = resolveAgyMcpConfigPath(env);
  const desired = buildOpenChamberMcpEntry({ cliEntryPath, env });

  let existing = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed;
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, configPath, error: err?.message || String(err) };
    }
  }

  const prevServers = existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {};
  const prev = prevServers[OPENCHAMBER_MCP_NAME];
  const unchanged = prev
    && prev.command === desired.command
    && JSON.stringify(prev.args) === JSON.stringify(desired.args)
    && prev.disabled === desired.disabled;

  if (unchanged) {
    return { ok: true, configPath, changed: false };
  }

  const next = {
    ...existing,
    mcpServers: {
      ...prevServers,
      [OPENCHAMBER_MCP_NAME]: desired,
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath);
  return { ok: true, configPath, changed: true };
}

async function resolveCoordinatedCallId(callLogPath, canonicalName) {
  if (callLogPath) {
    const deadline = Date.now() + 80;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(callLogPath, 'utf8');
        const lines = raw.trim().split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const entry = JSON.parse(lines[i]);
          if (entry?.tool === canonicalName && entry?.callID && Date.now() - (entry.ts || 0) < 10_000) {
            return String(entry.callID);
          }
        }
      } catch {
        // Call log not yet written
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return `call_agy_mcp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Execute one OpenChamber agent tool call over HTTP against `OPENCHAMBER_AGENT_TOOL_URL`.
 * Reuses OpenChamber's exact JSON envelope (`{ input, sessionID, contextDirectory, callID, tool }`).
 * @param {{ name: string, args: any, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} params
 */
export async function invokeOpenChamberAgentTool({ name, args, env = process.env, fetchImpl = fetch }) {
  const endpoint = env.OPENCHAMBER_AGENT_TOOL_URL?.trim();
  const token = env.OPENCHAMBER_AGENT_TOOL_TOKEN?.trim();
  if (!endpoint || !token) {
    return {
      isError: false,
      text: JSON.stringify({
        schemaVersion: 1,
        ok: false,
        action: args?.action || 'unknown',
        error: { message: 'OpenChamber managed tool connection is unavailable in this process.' },
      }),
    };
  }

  const canonicalName = normalizeOpenChamberToolName(name);
  const flattenedInput = args && typeof args === 'object' ? args : {};
  const { action: requestedAction, parameters, ...rest } = flattenedInput;
  const mergedInput = {
    ...rest,
    ...(parameters && typeof parameters === 'object' ? parameters : {}),
    ...(requestedAction !== undefined ? { action: requestedAction } : {}),
  };

  if (
    canonicalName === 'openchamber' &&
    ((mergedInput.action === 'session.create' && (mergedInput.ownWork === true || mergedInput.returnResult === true)) ||
      (mergedInput.action === 'session.send' && mergedInput.returnResult === true))
  ) {
    return {
      isError: false,
      text: JSON.stringify({
        schemaVersion: 1,
        ok: false,
        action: mergedInput.action,
        error: {
          message:
            'Cross-engine subagent delegation via openchamber (ownWork/returnResult) is disabled in agy-cli sessions to keep rules and tools consistent. Use native invoke_subagent / send_message / manage_subagents instead.',
        },
      }),
    };
  }

  const sessionID = env.OPENCHAMBER_ROUTER_SESSION_ID?.trim() || undefined;
  const contextDirectory = env.OPENCHAMBER_ROUTER_DIRECTORY?.trim() || process.cwd();
  const callID = await resolveCoordinatedCallId(env.OPENCHAMBER_ROUTER_CALL_LOG?.trim(), canonicalName);

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      input: mergedInput,
      ...(sessionID ? { sessionID } : {}),
      contextDirectory,
      callID,
      tool: canonicalName,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    return {
      isError: true,
      text: text || `OpenChamber agent-tool HTTP ${response.status}`,
    };
  }
  return {
    isError: false,
    text,
  };
}

/**
 * Run the lightweight stdio JSON-RPC 2.0 MCP server bridging OpenChamber agent tools to `agy-cli`.
 * Exposes tools ONLY when `OPENCHAMBER_AGENT_TOOL_URL` and `OPENCHAMBER_AGENT_TOOL_TOKEN` are set.
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [options]
 */
export function runMcpBridgeServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;

  let framingMode = 'ndjson';
  let buffer = Buffer.alloc(0);

  const sendResponse = (message) => {
    const payload = JSON.stringify(message);
    if (framingMode === 'lsp') {
      const byteLen = Buffer.byteLength(payload, 'utf8');
      output.write(`Content-Length: ${byteLen}\r\n\r\n${payload}`);
    } else {
      output.write(`${payload}\n`);
    }
  };

  const handleRequest = async (req) => {
    if (!req || typeof req !== 'object' || !req.method) return;
    const hasId = Object.hasOwn(req, 'id') && req.id !== undefined && req.id !== null;

    if (req.method === 'notifications/initialized' || req.method === 'initialized') {
      return;
    }

    if (!hasId) return;

    try {
      if (req.method === 'initialize') {
        const protocolVersion = req.params?.protocolVersion || '2024-11-05';
        sendResponse({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'agy-opencode-router-openchamber-bridge', version: '0.1.0' },
          },
        });
        return;
      }

      if (req.method === 'ping') {
        sendResponse({ jsonrpc: '2.0', id: req.id, result: {} });
        return;
      }

      if (req.method === 'tools/list') {
        const active = Boolean(env.OPENCHAMBER_AGENT_TOOL_URL?.trim() && env.OPENCHAMBER_AGENT_TOOL_TOKEN?.trim());
        const tools = active ? await loadOpenChamberToolSpecs({ env }) : [];
        sendResponse({ jsonrpc: '2.0', id: req.id, result: { tools } });
        return;
      }

      if (req.method === 'tools/call') {
        const toolName = req.params?.name;
        const toolArgs = req.params?.arguments || {};
        const result = await invokeOpenChamberAgentTool({
          name: toolName,
          args: toolArgs,
          env,
          fetchImpl,
        });
        sendResponse({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          },
        });
        return;
      }

      sendResponse({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
    } catch (error) {
      sendResponse({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const pumpBuffer = () => {
    while (buffer.length > 0) {
      // Support both LSP Content-Length framing and newline-delimited JSON
      const asTextStart = buffer.slice(0, Math.min(buffer.length, 32)).toString('utf8');
      if (/^Content-Length:/i.test(asTextStart)) {
        framingMode = 'lsp';
        const sepIdx = buffer.indexOf('\r\n\r\n');
        const sepLf = sepIdx === -1 ? buffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx !== -1 ? sepIdx : sepLf;
        const sepLen = sepIdx !== -1 ? 4 : 2;
        if (headerEnd === -1) return;

        const headerText = buffer.slice(0, headerEnd).toString('utf8');
        const lenMatch = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          buffer = buffer.slice(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number.parseInt(lenMatch[1], 10);
        const totalNeed = headerEnd + sepLen + contentLen;
        if (buffer.length < totalNeed) return;

        const body = buffer.slice(headerEnd + sepLen, totalNeed).toString('utf8');
        buffer = buffer.slice(totalNeed);
        try {
          void handleRequest(JSON.parse(body));
        } catch {
          // Ignore malformed JSON frame
        }
        continue;
      }

      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = buffer.slice(0, nlIdx).toString('utf8').trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        void handleRequest(JSON.parse(line));
      } catch {
        // Ignore malformed NDJSON line
      }
    }
  };

  input.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, buf]);
    pumpBuffer();
  });

  return new Promise((resolve) => {
    input.once('end', resolve);
    input.once('close', resolve);
  });
}
