import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyModelsOutput, toOpenCodeModelInfo, AGY_PROVIDER_ID } from '../src/agy-models.mjs';
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
