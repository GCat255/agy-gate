import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAcpToolResult,
  extractOpenChamberToolPayload,
  mergeAcpToolSnapshot,
  normalizeAcpToolInvocation,
} from '../src/agy/tool-adapter.mjs';
import { AgyTurnTranslator } from '../src/agy/event-translator.mjs';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tool-adapter-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('tool-adapter OpenChamber normalization & extensibility', () => {
  it('maps built-in agy tools & PascalCase inputs to OpenChamber canonical contract', () => {
    const readCall = normalizeAcpToolInvocation({
      name: 'read_file',
      rawInput: { Path: 'E:/proj/a.ts', StartLine: 10, EndLine: 25 },
    });
    assert.equal(readCall.name, 'read');
    assert.deepEqual(readCall.input, { path: 'E:/proj/a.ts', offset: 10, limit: 16 });

    const writeCall = normalizeAcpToolInvocation({
      name: 'write_file',
      rawInput: { TargetFile: 'E:/proj/b.py', Content: 'print(1)' },
    });
    assert.equal(writeCall.name, 'write');
    assert.deepEqual(writeCall.input, { path: 'E:/proj/b.py', content: 'print(1)' });

    const editCall = normalizeAcpToolInvocation({
      name: 'edit_file',
      rawInput: { Path: 'E:/proj/b.py', Target: 'print(1)', Replacement: 'print(2)' },
    });
    assert.equal(editCall.name, 'edit');
    assert.deepEqual(editCall.input, { path: 'E:/proj/b.py', oldString: 'print(1)', newString: 'print(2)' });

    const shellCall = normalizeAcpToolInvocation({
      name: 'run_command',
      rawInput: { CommandLine: 'npm test', toolSummary: 'Run test suite', WaitMsBeforeAsync: 5000 },
    });
    assert.equal(shellCall.name, 'shell');
    assert.deepEqual(shellCall.input, {
      command: 'npm test',
      description: 'Run test suite',
      timeout: 5000,
    });

    const grepCall = normalizeAcpToolInvocation({
      name: 'grep_search',
      rawInput: { Query: 'handleAcp', SearchPath: 'E:/proj/src' },
    });
    assert.equal(grepCall.name, 'grep');
    assert.deepEqual(grepCall.input, { pattern: 'handleAcp', path: 'E:/proj/src' });

    const listDirCall = normalizeAcpToolInvocation({
      name: 'list_dir',
      rawInput: { DirectoryPath: 'E:/proj/src' },
    });
    assert.equal(listDirCall.name, 'glob');
    assert.deepEqual(listDirCall.input, { pattern: '*', path: 'E:/proj/src' });
  });

  it('adapts to future contract renames dynamically via semanticRoles lookup', () => {
    const futureContract = {
      source: 'openchamber-live',
      semanticRoles: { read: 'read_v2', shell: 'terminal' },
      canonicalTools: { read_v2: { inputFields: ['path'] }, terminal: { inputFields: ['command'] } },
    };
    const readCall = normalizeAcpToolInvocation(
      { name: 'read_file', rawInput: { Path: 'E:/proj/x.txt' } },
      { contract: futureContract },
    );
    assert.equal(readCall.name, 'read_v2');

    const shellCall = normalizeAcpToolInvocation(
      { name: 'run_command', rawInput: { CommandLine: 'echo hi' } },
      { contract: futureContract },
    );
    assert.equal(shellCall.name, 'terminal');
  });

  it('unwraps generic MCP tools and read_resource with readable descriptions', () => {
    const mcpCall = normalizeAcpToolInvocation({
      name: 'call_mcp_tool',
      rawInput: {
        ServerName: 'unity-mcp',
        ToolName: 'manage_camera',
        Arguments: { action: 'screenshot', max_resolution: 640 },
      },
    });
    assert.equal(mcpCall.name, 'unity-mcp/manage_camera');
    assert.equal(mcpCall.input.description, 'screenshot');
    assert.equal(mcpCall.isOpenChamberTool, false);

    const resCall = normalizeAcpToolInvocation({
      name: 'read_resource',
      rawInput: { ServerName: 'unity-mcp', Uri: 'mcpforunity://editor/state' },
    });
    assert.equal(resCall.name, 'read_resource');
    assert.equal(resCall.input.description, 'unity-mcp · mcpforunity://editor/state');
  });

  it('attaches inline image data URI & summary when read_file inspects a PNG with empty ACP output', async () => {
    await withTempDir(async (dir) => {
      const pngPath = path.join(dir, 'media_0.png');
      await fs.writeFile(pngPath, ONE_PIXEL_PNG);

      const events = [];
      const tr = new AgyTurnTranslator({
        sessionID: 'ses_img',
        assistantMessageID: 'msg_img',
        modelID: 'gemini-4-hydrogen-high',
        emit: (ev) => events.push(ev),
      });
      tr.begin();

      // Progressive update: initial tool_call has empty input, update fills Path, completed has empty output
      tr.handleAcpUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_img_1',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        rawInput: {},
      });
      tr.handleAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_img_1',
        name: 'read_file',
        kind: 'read',
        status: 'completed',
        locations: [{ path: pngPath }],
        rawInput: { Path: pngPath },
      });

      const msg = tr.complete();
      const started = events.find((e) => e.type === 'session.tool.input.started');
      assert.equal(started.data.name, 'read');

      const calledEvents = events.filter((e) => e.type === 'session.tool.called');
      assert.equal(calledEvents.length, 2, 'Should emit refined called event when progressive input arrives');
      assert.deepEqual(calledEvents[1].data.input, { path: pngPath });

      const success = events.find((e) => e.type === 'session.tool.success');
      assert.ok(success.data.content.some((c) => c.type === 'text' && c.text.includes('Read image:')));
      const filePart = success.data.content.find((c) => c.type === 'file');
      assert.ok(filePart);
      assert.equal(filePart.mime, 'image/png');
      assert.equal(filePart.name, 'media_0.png');
      assert.ok(filePart.uri.startsWith('data:image/png;base64,'));

      assert.equal(msg.content[0].name, 'read');
      assert.equal(msg.content[0].state.input.path, pngPath);
      assert.ok(msg.content[0].state.content.some((c) => c.type === 'file'));
    });
  });

  it('handles unseen future agy tools cleanly using ACP kind, locations, and title', () => {
    const snap = mergeAcpToolSnapshot(null, {
      name: 'future_visual_inspector',
      kind: 'read',
      title: 'Inspect C:/tmp/frame.png',
      locations: [{ path: 'C:/tmp/frame.png' }],
      rawInput: { Zoom: 2 },
    });
    const normalized = normalizeAcpToolInvocation(snap);
    assert.equal(normalized.name, 'future_visual_inspector');
    assert.equal(normalized.input.path, 'C:/tmp/frame.png');
    assert.equal(normalized.input.description, 'Inspect C:/tmp/frame.png');
    assert.equal(normalized.isImageRead, true);

    const res = buildAcpToolResult({ content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }, normalized);
    assert.equal(res.outputText, 'ok');
  });

  it('produces minimal unified diff hunks instead of whole-file replacement on partial edits', () => {
    const oldLines = Array.from({ length: 800 }, (_, i) => `line ${i + 1}: original`);
    const newLines = [...oldLines];
    newLines[19] = 'line 20: updated one';
    newLines.splice(500, 1, 'line 501: replaced A', 'line 501b: added B');

    const res = buildAcpToolResult(
      {
        content: [
          {
            type: 'diff',
            path: 'Assets/Scripts/PanelBlackMaskTransition.cs',
            oldText: oldLines.join('\n'),
            newText: newLines.join('\n'),
          },
        ],
      },
      normalizeAcpToolInvocation({ name: 'edit_file', rawInput: { TargetFile: 'Assets/Scripts/PanelBlackMaskTransition.cs' } }),
    );

    assert.ok(res.diffMeta?.filediff?.patch);
    assert.equal(res.diffMeta.filediff.additions, 3);
    assert.equal(res.diffMeta.filediff.deletions, 2);
    const hunkHeaders = res.diffMeta.filediff.patch.match(/^@@ -\d+,\d+ \+\d+,\d+ @@$/gm) || [];
    assert.equal(hunkHeaders.length, 2);
    assert.ok(res.diffMeta.filediff.patch.includes('-line 20: original'));
    assert.ok(res.diffMeta.filediff.patch.includes('+line 20: updated one'));
    assert.ok(!res.diffMeta.filediff.patch.includes('line 100: original'));

    // New file creation emits /dev/null header
    const createdRes = buildAcpToolResult(
      { content: [{ type: 'diff', path: 'src/new.mjs', oldText: '', newText: 'a\nb' }] },
      normalizeAcpToolInvocation({ name: 'write_file', rawInput: { Path: 'src/new.mjs' } }),
    );
    assert.equal(createdRes.diffMeta.filediff.additions, 2);
    assert.equal(createdRes.diffMeta.filediff.deletions, 0);
    assert.ok(createdRes.diffMeta.filediff.patch.startsWith('--- /dev/null\n+++ b/src/new.mjs\n@@ -0,0 +1,2 @@'));
  });

  it('deduplicates rawOutput + content and extracts wrapped OpenChamber tool payloads', () => {
    const envelope = {
      schemaVersion: 1,
      ok: true,
      action: 'render.page',
      data: {
        title: 'Choose timing',
        answer: { answered: true, summary: 'Option A', data: { button: 'Send', values: { seq: 'Option A' } } },
      },
    };
    const jsonStr = JSON.stringify(envelope);
    const update = {
      rawOutput: { content: [{ type: 'text', text: jsonStr }] },
      content: [{ type: 'content', content: { type: 'text', text: jsonStr } }],
    };
    const normalized = normalizeAcpToolInvocation({
      name: 'mcp__openchamber__openchamber_render',
      rawInput: { ui: 'root = Stack([])', awaitAnswer: true },
    });
    const res = buildAcpToolResult(update, normalized);
    assert.equal(res.outputText, jsonStr);
    const extracted = extractOpenChamberToolPayload(update, res.outputText);
    assert.deepEqual(extracted, envelope);
  });
});
