import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  buildSessionGuidancePrefix,
  loadOpenChamberGuidance,
  loadOpenChamberToolSpecs,
  probeOpenChamberCompat,
  resolveOpenChamberWebRoot,
} from '../src/bridge/openchamber.mjs';
import {
  ensureOpenChamberMcpConfig,
  normalizeOpenChamberToolName,
  runMcpBridgeServer,
} from '../src/bridge/mcp.mjs';
import { AgyTurnTranslator } from '../src/agy/event-translator.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-oc-bridge-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('openchamber-bridge dynamic discovery & guidance', () => {
  it('loads openui-lang guidance and gracefully falls back when OPENCHAMBER_WEB_ROOT is absent', async () => {
    const installedRoot = resolveOpenChamberWebRoot(process.env);
    if (installedRoot) {
      const liveGuidance = await loadOpenChamberGuidance({ env: process.env, forceRefresh: true });
      assert.equal(liveGuidance.source, 'openchamber-live');
      assert.ok(liveGuidance.uiBlocksGuidance.includes('openui-lang'));

      const liveTools = await loadOpenChamberToolSpecs({ env: process.env, forceRefresh: true });
      const names = liveTools.map((t) => t.name);
      assert.ok(names.includes('openchamber'));
      const openchamberTool = liveTools.find((t) => t.name === 'openchamber');
      assert.ok(openchamberTool.description.length > 200, 'Should capture full OpenChamber tool schema rather than fallback');
      const renderTool = liveTools.find((t) => t.name === 'openchamber_render');
      assert.ok(renderTool);
      assert.ok(renderTool.description.includes('openui-lang'));
      assert.ok(renderTool.description.includes('ask_question'));
      assert.ok(renderTool.inputSchema?.properties?.parameters?.properties?.ui);
      assert.ok(renderTool.inputSchema?.properties?.parameters?.properties?.awaitAnswer);
    }

    const fallbackPrefix = await buildSessionGuidancePrefix({
      env: { OPENCHAMBER_WEB_ROOT: 'Z:/does-not-exist' },
      forceRefresh: true,
      hasMcpBridge: true,
    });
    assert.ok(fallbackPrefix.includes('<openchamber_runtime_guidance>'));
    assert.ok(fallbackPrefix.includes('openui-lang'));
    assert.ok(fallbackPrefix.includes('ask_question'));
    assert.ok(fallbackPrefix.length < 600, 'Turn-1 guidance pointer should stay compact for prompt cache efficiency');

    await withTempDir(async (fakeRoot) => {
      await fs.writeFile(path.join(fakeRoot, 'package.json'), JSON.stringify({ name: '@openchamber/web', version: '9.9.9' }), 'utf8');
      const degradedProbe = await probeOpenChamberCompat({
        env: { OPENCHAMBER_WEB_ROOT: fakeRoot },
        forceRefresh: true,
      });
      assert.equal(degradedProbe.degraded, true);
      assert.equal(degradedProbe.webVersion, '9.9.9');
      assert.equal(degradedProbe.guidanceSource, 'fallback');
      assert.equal(degradedProbe.toolSpecSource, 'fallback');
    });

    if (installedRoot) {
      const liveProbe = await probeOpenChamberCompat({ env: process.env, forceRefresh: true });
      assert.equal(liveProbe.degraded, false);
      assert.equal(liveProbe.guidanceSource, 'openchamber-live');
      assert.equal(liveProbe.toolSpecSource, 'openchamber-live');
      assert.ok(liveProbe.toolNames.includes('openchamber_render'));
    }
  });
});

describe('mcp-bridge registration, env gating, and OpenChamber HTTP forwarding', () => {
  it('idempotently registers only mcpServers.openchamber while preserving existing servers', async () => {
    await withTempDir(async (dir) => {
      const mcpConfig = path.join(dir, 'mcp_config.json');
      await fs.writeFile(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            'unity-mcp': { command: 'uv.exe', args: ['run'], disabled: false },
          },
        }),
        'utf8',
      );

      const cliEntry = path.resolve(import.meta.dirname, '..', 'bin', 'agy-gate.mjs');
      const first = ensureOpenChamberMcpConfig({
        cliEntryPath: cliEntry,
        env: { AGY_MCP_CONFIG_PATH: mcpConfig },
      });
      assert.equal(first.ok, true);
      assert.equal(first.changed, true);

      const second = ensureOpenChamberMcpConfig({
        cliEntryPath: cliEntry,
        env: { AGY_MCP_CONFIG_PATH: mcpConfig },
      });
      assert.equal(second.ok, true);
      assert.equal(second.changed, false);

      const saved = JSON.parse(await fs.readFile(mcpConfig, 'utf8'));
      assert.deepEqual(saved.mcpServers['unity-mcp'], { command: 'uv.exe', args: ['run'], disabled: false });
      assert.equal(saved.mcpServers.openchamber.disabled, false);
      assert.ok(saved.mcpServers.openchamber.args.includes('mcp-bridge'));
    });
  });

  it('hides tools outside OpenChamber and forwards tool calls when OPENCHAMBER_AGENT_TOOL_URL is set', async () => {
    // 1. Outside OpenChamber -> empty tool list
    {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const responses = [];
      stdout.on('data', (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (line.trim()) responses.push(JSON.parse(line));
        }
      });

      const done = runMcpBridgeServer({ input: stdin, output: stdout, env: {} });
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      await new Promise((r) => setTimeout(r, 40));
      stdin.end();
      await done;

      const listRes = responses.find((r) => r.id === 2);
      assert.deepEqual(listRes?.result?.tools, []);
    }

    // 2. Inside OpenChamber -> forwards tools/call with sessionID, contextDirectory & token
    {
      const captured = [];
      const mockFetch = async (url, init) => {
        captured.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            ok: true,
            action: 'render.page',
            data: { answer: { answered: true, summary: 'Option A' } },
          }),
          { status: 200 },
        );
      };

      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const responses = [];
      stdout.on('data', (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (line.trim()) responses.push(JSON.parse(line));
        }
      });

      const done = runMcpBridgeServer({
        input: stdin,
        output: stdout,
        env: {
          OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3000/api/openchamber/agent-tool',
          OPENCHAMBER_AGENT_TOOL_TOKEN: 'secret-bridge-token',
          OPENCHAMBER_ROUTER_SESSION_ID: 'ses_bridge_1',
          OPENCHAMBER_ROUTER_DIRECTORY: 'E:/proj',
          OPENCHAMBER_WEB_ROOT: 'Z:/no-web',
        },
        fetchImpl: mockFetch,
      });

      stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'openchamber_render',
            arguments: { action: 'render.page', parameters: { ui: 'root = Stack([])', awaitAnswer: true } },
          },
        }) + '\n',
      );
      await new Promise((r) => setTimeout(r, 60));
      stdin.end();
      await done;

      const listRes = responses.find((r) => r.id === 1);
      assert.ok(listRes.result.tools.some((t) => t.name === 'openchamber_render'));

      const callRes = responses.find((r) => r.id === 2);
      assert.equal(callRes.result.isError, undefined);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].headers.authorization, 'Bearer secret-bridge-token');
      assert.equal(captured[0].body.sessionID, 'ses_bridge_1');
      assert.equal(captured[0].body.contextDirectory, 'E:/proj');
      assert.equal(captured[0].body.tool, 'openchamber_render');
      assert.equal(captured[0].body.input.action, 'render.page');
      assert.equal(captured[0].body.input.awaitAnswer, true);
    }
  });
});

describe('event-translator OpenChamber MCP normalization', () => {
  it('strips mcp prefix and unwraps agy call_mcp_tool wrapper with coordinated callID', async () => {
    assert.equal(normalizeOpenChamberToolName('mcp__openchamber__openchamber_render'), 'openchamber_render');
    assert.equal(normalizeOpenChamberToolName('openchamber/openchamber_web'), 'openchamber_web');

    await withTempDir(async (dir) => {
      const callLogPath = path.join(dir, 'calls.jsonl');
      const events = [];
      const tr = new AgyTurnTranslator({
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        modelID: 'gemini-4-hydrogen',
        emit: (e) => events.push(e),
        onOpenChamberToolStart: ({ tool, callID }) => {
          fs.appendFile(callLogPath, `${JSON.stringify({ tool, callID, ts: Date.now() })}\n`).catch(() => {});
        },
      });

      tr.handleLine({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'call_mcp_tool',
          tool_info: {
            parameters: {
              ServerName: 'openchamber',
              ToolName: 'openchamber_render',
              Arguments: { action: 'render.page', parameters: { ui: 'root = Stack([])', awaitAnswer: true } },
            },
          },
        },
      });

      await new Promise((r) => setTimeout(r, 30));

      // Simulate mcp-bridge reading the coordinated callID before POSTing to OpenChamber
      const captured = [];
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const done = runMcpBridgeServer({
        input: stdin,
        output: stdout,
        env: {
          OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3000/api/openchamber/agent-tool',
          OPENCHAMBER_AGENT_TOOL_TOKEN: 'tok',
          OPENCHAMBER_ROUTER_CALL_LOG: callLogPath,
          OPENCHAMBER_ROUTER_SESSION_ID: 'ses_1',
        },
        fetchImpl: async (_url, init) => {
          captured.push(JSON.parse(String(init.body)));
          return new Response(
            JSON.stringify({ schemaVersion: 1, ok: true, action: 'render.page', data: { answer: { answered: true, summary: 'Use B' } } }),
            { status: 200 },
          );
        },
      });
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'openchamber_render', arguments: { action: 'render.page', parameters: { ui: 'root = Stack([])', awaitAnswer: true } } },
        }) + '\n',
      );
      await new Promise((r) => setTimeout(r, 50));
      stdin.end();
      await done;

      tr.handleLine({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'call_mcp_tool',
          tool_info: {
            parameters: {
              ServerName: 'openchamber',
              ToolName: 'openchamber_render',
              Arguments: { action: 'render.page', parameters: { ui: 'root = Stack([])', awaitAnswer: true } },
            },
            output: JSON.stringify({
              schemaVersion: 1,
              ok: true,
              action: 'render.page',
              data: { answer: { answered: true, summary: 'Use B' } },
            }),
          },
        },
      });
      const msg = tr.complete();

      const started = events.find((e) => e.type === 'session.tool.input.started');
      assert.equal(started.data.name, 'openchamber_render');
      assert.equal(captured[0].callID, started.data.id, 'mcp-bridge callID must match UI tool part callID');

      const success = events.find((e) => e.type === 'session.tool.success');
      assert.equal(success.data.metadata.openchamber.ok, true);
      assert.equal(success.data.metadata.openchamber.action, 'render.page');
      assert.equal(success.data.metadata.openchamber.answer.summary, 'Use B');

      assert.equal(msg.content[0].name, 'openchamber_render');
      assert.deepEqual(msg.content[0].state.input, {
        action: 'render.page',
        parameters: { ui: 'root = Stack([])', awaitAnswer: true },
      });
      assert.equal(msg.content[0].state.metadata.openchamber.answer.answered, true);
    });
  });
});
