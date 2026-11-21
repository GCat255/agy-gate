import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatSetupReport,
  registerOpenChamberEngine,
  registerOpenChamberQuotaExtension,
  runSetup,
} from '../src/setup.mjs';

test('registerOpenChamberEngine binds and restores opencodeBinary while preserving other settings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-eng-'));
  try {
    const settingsPath = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ themeId: 'dark', desktopLocalPort: 3000 }), 'utf8');

    const res = registerOpenChamberEngine({ dataDir: tmp, routerBinary: 'C:\\bin\\agy-opencode-router.cmd' });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'updated');

    const afterBind = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(afterBind.opencodeBinary, 'C:\\bin\\agy-opencode-router.cmd');
    assert.equal(afterBind.themeId, 'dark');

    const idempotent = registerOpenChamberEngine({ dataDir: tmp, routerBinary: 'C:\\bin\\agy-opencode-router.cmd' });
    assert.equal(idempotent.action, 'unchanged');

    const restored = registerOpenChamberEngine({ dataDir: tmp, restore: true });
    assert.equal(restored.action, 'removed');
    const afterRestore = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(afterRestore.opencodeBinary, undefined);
    assert.equal(afterRestore.themeId, 'dark');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('registerOpenChamberQuotaExtension idempotently registers agy-quota and preserves unrelated extensions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-ext-'));
  try {
    const extDir = path.join(tmp, 'repo', 'extensions', 'agy-quota');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ name: 'agy-quota' }), 'utf8');

    const ocDir = path.join(tmp, 'oc');
    fs.mkdirSync(ocDir, { recursive: true });
    const extJsonPath = path.join(ocDir, 'extensions.json');
    fs.writeFileSync(
      extJsonPath,
      JSON.stringify({
        paths: ['C:\\other\\ext', 'C:\\old-location\\extensions\\agy-quota'],
        capabilityGrants: { 'other-ext': ['service'] },
        capabilityScopes: { 'other-ext': { service: {} } },
        storageIds: { 'other-ext': 'id-1', 'agy-quota': 'keep-existing-id' },
      }),
      'utf8',
    );

    const res = registerOpenChamberQuotaExtension({ dataDir: ocDir, extensionDir: extDir });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'updated');

    const saved = JSON.parse(fs.readFileSync(extJsonPath, 'utf8'));
    assert.deepEqual(saved.paths, ['C:\\other\\ext', path.resolve(extDir)]);
    assert.deepEqual(saved.capabilityGrants['agy-quota'], ['service']);
    assert.deepEqual(saved.capabilityGrants['other-ext'], ['service']);
    assert.equal(saved.storageIds['agy-quota'], 'keep-existing-id');

    const removed = registerOpenChamberQuotaExtension({ dataDir: ocDir, extensionDir: extDir, remove: true });
    assert.equal(removed.action, 'removed');
    const afterRemove = JSON.parse(fs.readFileSync(extJsonPath, 'utf8'));
    assert.deepEqual(afterRemove.paths, ['C:\\other\\ext']);
    assert.equal(afterRemove.capabilityGrants['agy-quota'], undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSetup wires engine, extension, and mcp_config cleanly in isolated temp dirs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-all-'));
  try {
    const ocDir = path.join(tmp, 'openchamber');
    const dataDir = path.join(tmp, 'router-data');
    const mcpPath = path.join(tmp, 'gemini', 'mcp_config.json');
    const env = {
      ...process.env,
      OPENCHAMBER_DATA_DIR: ocDir,
      AGY_ROUTER_DATA_DIR: dataDir,
      AGY_MCP_CONFIG_PATH: mcpPath,
    };

    const result = await runSetup({
      env,
      cliEntryPath: path.resolve('E:/agy_projects/agy-opencode-router/bin/agy-opencode-router.mjs'),
      routerRoot: path.resolve('E:/agy_projects/agy-opencode-router'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.steps.engine.action, 'updated');
    assert.equal(result.steps.quotaExtension.action, 'updated');
    assert.equal(result.steps.mcp.ok, true);
    assert.equal(fs.existsSync(path.join(ocDir, 'settings.json')), true);
    assert.equal(fs.existsSync(path.join(ocDir, 'extensions.json')), true);
    assert.equal(fs.existsSync(mcpPath), true);

    const report = formatSetupReport(result);
    assert.match(report, /环境初始化结果/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
