import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureAgyFastPlugin,
  inspectAgyFastPlugin,
  summarizeAgyFastTool,
  unwrapAgyFastToolInvocation,
} from '../src/agy/fast-plugin.mjs';
import { isPlanBlockedPermissionRequest } from '../src/agy/runner.mjs';

function makeTempGeminiHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fast-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('agy-fast integration helpers', () => {
  it('unwraps call_mcp_tool and direct/prefixed agy-fast tool names accurately', () => {
    const wrapped = unwrapAgyFastToolInvocation('call_mcp_tool', {
      ServerName: 'agy-fast_fast',
      ToolName: 'quick_outline',
      Arguments: JSON.stringify({ paths: ['package.json'], toolSummary: 'Outline package.json' }),
    });
    assert.equal(wrapped.isAgyFast, true);
    assert.equal(wrapped.toolName, 'quick_outline');
    assert.equal(wrapped.readOnly, true);
    assert.equal(wrapped.mutating, false);
    assert.deepEqual(wrapped.args.paths, ['package.json']);

    const eager = unwrapAgyFastToolInvocation('mcp__agy-fast_fast__apply_edits', {
      edits: [{ path: 'src/a.mjs', hunks: [] }],
      verify: 'npm test',
    });
    assert.equal(eager.isAgyFast, true);
    assert.equal(eager.toolName, 'apply_edits');
    assert.equal(eager.readOnly, false);
    assert.equal(eager.mutating, true);

    const otherMcp = unwrapAgyFastToolInvocation('call_mcp_tool', {
      ServerName: 'unity-mcp',
      ToolName: 'manage_camera',
      Arguments: { action: 'screenshot' },
    });
    assert.equal(otherMcp.isAgyFast, false);
  });

  it('summarizes agy-fast parameters into concise descriptions and target paths', () => {
    assert.deepEqual(
      summarizeAgyFastTool('quick_outline', { paths: ['a.mjs', 'b.mjs'], toolSummary: 'Map core modules' }),
      { description: 'Map core modules', targetPath: 'a.mjs' },
    );
    assert.deepEqual(
      summarizeAgyFastTool('batch_search', {
        queries: [
          { type: 'text', pattern: 'foo', path: 'src/' },
          { type: 'regex', pattern: 'bar' },
        ],
      }),
      { description: '2 queries: foo, bar', targetPath: 'src/' },
    );
    assert.deepEqual(
      summarizeAgyFastTool('read_slices', { lineRanges: ['src/app.mjs:10-40'] }),
      { description: 'src/app.mjs', targetPath: 'src/app.mjs' },
    );
    assert.deepEqual(
      summarizeAgyFastTool('apply_edits', {
        edits: [{ path: 'src/a.mjs' }, { path: 'src/b.mjs' }],
        verify: 'npm test',
      }),
      { description: 'src/a.mjs, src/b.mjs + verify', targetPath: 'src/a.mjs' },
    );
    assert.deepEqual(
      summarizeAgyFastTool('run_checks', {
        commands: [{ name: 'typecheck', command: 'npm run check' }, { command: 'npm test' }],
      }),
      { description: 'typecheck, npm test', targetPath: undefined },
    );
  });

  it('allows read-only agy-fast tools in Plan mode even with kind=execute and blocks mutating ones', () => {
    for (const readTool of ['batch_search', 'quick_outline', 'read_slices']) {
      assert.equal(
        isPlanBlockedPermissionRequest({
          toolCall: {
            name: 'call_mcp_tool',
            kind: 'execute',
            rawInput: {
              ServerName: 'agy-fast_fast',
              ToolName: readTool,
              Arguments: { paths: ['package.json'] },
            },
          },
        }),
        false,
        `${readTool} should be allowed in Plan mode`,
      );
    }

    for (const mutatingTool of ['apply_edits', 'run_checks']) {
      assert.equal(
        isPlanBlockedPermissionRequest({
          toolCall: {
            name: 'call_mcp_tool',
            kind: 'other',
            rawInput: {
              ServerName: 'agy-fast_fast',
              ToolName: mutatingTool,
              Arguments: {},
            },
          },
        }),
        true,
        `${mutatingTool} should be blocked in Plan mode`,
      );
      assert.equal(
        isPlanBlockedPermissionRequest({
          toolCall: {
            name: `mcp__agy-fast_fast__${mutatingTool}`,
            kind: 'other',
            rawInput: {},
          },
        }),
        true,
      );
    }

    assert.equal(
      isPlanBlockedPermissionRequest({
        toolCall: { name: 'edit_file', kind: 'edit', rawInput: {} },
      }),
      true,
    );
  });

  it('inspects agy-fast installation state and metadata in isolated GEMINI_HOME', () => {
    makeTempGeminiHome((geminiHome) => {
      const env = { ...process.env, GEMINI_HOME: geminiHome, AGY_ROUTER_HOME_DIR: '' };
      const missing = inspectAgyFastPlugin({ env, probeRipgrep: false });
      assert.equal(missing.installed, false);
      assert.equal(missing.healthy, false);
      assert.equal(missing.toolLoading, 'none');

      const noInstallRes = ensureAgyFastPlugin({ env, installIfMissing: false });
      assert.equal(noInstallRes.ok, true);
      assert.equal(noInstallRes.action, 'not-installed');

      const pluginDir = path.join(geminiHome, 'config', 'plugins', 'agy-fast');
      fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'agy-fast', version: '0.3.1' }));
      fs.writeFileSync(
        path.join(pluginDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            fast: {
              command: 'node',
              args: ['${PLUGIN_ROOT}/dist/mcp-server.mjs'],
              tools: {
                batch_search: { eager: true },
                apply_edits: { eager: true },
                read_slices: { eager: true },
                quick_outline: { eager: true },
                run_checks: { eager: true },
              },
            },
          },
        }),
      );
      fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify({ 'agy-fast-snapshot': { SessionStart: [] } }));
      fs.writeFileSync(path.join(pluginDir, 'dist', 'mcp-server.mjs'), '// ok');
      fs.writeFileSync(path.join(pluginDir, 'dist', 'session-start.mjs'), '// ok');
      fs.writeFileSync(path.join(pluginDir, 'rules', 'AGENTS.md'), '# rules');

      const healthy = inspectAgyFastPlugin({ env, probeRipgrep: false });
      assert.equal(healthy.installed, true);
      assert.equal(healthy.enabled, true);
      assert.equal(healthy.healthy, true);
      assert.equal(healthy.version, '0.3.1');
      assert.equal(healthy.toolLoading, 'eager');
      assert.equal(healthy.eagerToolsCount, 5);
    });
  });
});
