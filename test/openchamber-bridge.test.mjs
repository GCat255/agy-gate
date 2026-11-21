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
  resolveOpenChamberWebRoot,
} from '../src/openchamber-bridge.mjs';
import {
  ensureOpenChamberMcpConfig,
  normalizeOpenChamberToolName,
  runMcpBridgeServer,
} from '../src/mcp-bridge.mjs';
import { AgyTurnTranslator } from '../src/event-translator.mjs';

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
      assert.ok(names.includes('openchamber_render'));
    }

    const fallbackPrefix = await buildSessionGuidancePrefix({
      env: { OPENCHAMBER_WEB_ROOT: 'Z:/does-not-exist' },
      forceRefresh: true,
      hasMcpBridge: true,
    });
    assert.ok(fallbackPrefix.includes('<openchamber_runtime_guidance>'));
    assert.ok(fallbackPrefix.includes('openui-lang'));
    assert.ok(fallbackPrefix.includes('ask_question'));
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

      const cliEntry = path.resolve(import.meta.dirname, '..', 'bin', 'agy-opencode-router.mjs');
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
  it('strips mcp prefix from OpenChamber tool names and populates state.metadata.openchamber', () => {
    assert.equal(normalizeOpenChamberToolName('mcp__openchamber__openchamber_render'), 'openchamber_render');
    assert.equal(normalizeOpenChamberToolName('openchamber/openchamber_web'), 'openchamber_web');

    const events = [];
    const tr = new AgyTurnTranslator({
      sessionID: 'ses_1',
      assistantMessageID: 'msg_1',
      modelID: 'gemini-4-hydrogen',
      emit: (e) => events.push(e),
    });

    tr.handleLine({
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'mcp__openchamber__openchamber_render',
        tool_info: {
          parameters: { action: 'render.page', ui: 'root = Stack([])', awaitAnswer: true },
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

    const success = events.find((e) => e.type === 'session.tool.success');
    assert.equal(success.data.metadata.openchamber.ok, true);
    assert.equal(success.data.metadata.openchamber.action, 'render.page');
    assert.equal(success.data.metadata.openchamber.answer.summary, 'Use B');

    assert.equal(msg.content[0].name, 'openchamber_render');
    assert.equal(msg.content[0].state.metadata.openchamber.answer.answered, true);
  });
});
