import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgyCatalog, parseAgyModelsOutput, toOpenCodeModelInfo, AGY_PROVIDER_ID } from '../src/agy-models.mjs';
import { parseMagpieEnvOutput, redactMagpieSummary } from '../src/magpie-env.mjs';

test('parseAgyModelsOutput parses tab-separated models and skips noise', () => {
  const sample = [
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
    'gemini-4-neon-high\tDuplicate',
    '',
  ].join('\n');

  const parsed = parseAgyModelsOutput(sample);
  assert.deepEqual(parsed, [
    { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
  ]);

  const modelInfo = toOpenCodeModelInfo(parsed[0]);
  assert.equal(modelInfo.providerID, AGY_PROVIDER_ID);
  assert.equal(modelInfo.modelID, 'gemini-4-neon-high');
  assert.equal(modelInfo.type, 'chat');
  assert.equal(modelInfo.status, 'active');
  assert.equal(modelInfo.enabled, true);
});

test('parseMagpieEnvOutput separates settings/model and redacts secrets in summary', () => {
  const parsed = parseMagpieEnvOutput([
    'GEMINI_API_KEY=dummy-secret-value',
    'GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9999',
    'settings=C:\\tmp\\settings.json',
    'model=gemini-4-hydrogen-high',
  ].join('\n'));

  assert.equal(parsed.settingsPath, 'C:\\tmp\\settings.json');
  assert.equal(parsed.defaultModel, 'gemini-4-hydrogen-high');
  assert.equal(parsed.envPatch.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:9999');

  const summary = redactMagpieSummary({ available: true, ...parsed });
  assert.equal(JSON.stringify(summary).includes('dummy-secret-value'), false);
  assert.deepEqual(summary.envKeys, ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL']);
});

test('getAgyCatalog excludes magpie/ prefixed models by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-catalog-'));
  try {
    const mockAgyJs = path.join(dir, 'mock-agy.mjs');
    const mockAgyCmd = path.join(dir, process.platform === 'win32' ? 'mock-agy.cmd' : 'mock-agy.sh');
    fs.writeFileSync(
      mockAgyJs,
      [
        "console.log('Fetching available models...');",
        "console.log('gemini-4-hydrogen-high\\tGemini 4 Hydrogen (High)');",
        "console.log('magpie/codex/gpt-6-luna\\tmagpie/codex/gpt-6-luna');",
      ].join('\n'),
      'utf8',
    );
    if (process.platform === 'win32') {
      fs.writeFileSync(mockAgyCmd, `@echo off\r\n"${process.execPath}" "${mockAgyJs}" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(mockAgyCmd, `#!/usr/bin/env bash\n"${process.execPath}" "${mockAgyJs}" "$@"\n`, { mode: 0o755 });
    }

    const catalog = getAgyCatalog({
      forceRefresh: true,
      env: { ...process.env, AGY_ROUTER_AGY_BIN: mockAgyCmd },
    });
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ['gemini-4-hydrogen-high'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
