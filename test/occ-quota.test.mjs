import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatQuotaWindowsSummary,
  inspectQuotaExtensionRegistration,
  probeQuotaHealth,
} from '../src/occ/services.mjs';

test('inspectQuotaExtensionRegistration and probeQuotaHealth detect unregistered, disabled, op-unmounted, op-error, and op-ok states', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-occ-quota-'));
  try {
    const dataDir = path.join(tmp, 'agy-gate');
    const ocDir = path.join(tmp, 'openchamber');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(ocDir, { recursive: true });
    const env = {
      ...process.env,
      AGY_GATE_DATA_DIR: dataDir,
      OPENCHAMBER_DATA_DIR: ocDir,
    };

    // 1. Unauthenticated
    const unauth = await probeQuotaHealth({ state: 'stopped', port: 3000 }, { env });
    assert.equal(unauth.status, 'unauth');

    // Write auth file
    fs.writeFileSync(
      path.join(dataDir, 'quota-auth.json'),
      JSON.stringify({ email: 'u@example.com', refreshToken: 'ref-1' }),
      'utf8',
    );

    // 2. Authorized but missing extensions.json
    const unreg = await probeQuotaHealth({ state: 'stopped', port: 3000 }, { env });
    assert.equal(unreg.status, 'unregistered');
    assert.equal(unreg.ext.enabled, false);

    // 3. Registered but disabled in extensions.json
    fs.writeFileSync(
      path.join(ocDir, 'extensions.json'),
      JSON.stringify({
        paths: ['E:\\repo\\extensions\\agy-quota'],
        capabilityGrants: { 'agy-quota': ['service'] },
        disabledGuests: { 'agy-quota': true },
      }),
      'utf8',
    );
    const disabledExt = inspectQuotaExtensionRegistration(env);
    assert.equal(disabledExt.disabled, true);
    assert.equal(disabledExt.enabled, false);

    // 4. Enabled in extensions.json, OP stopped
    fs.writeFileSync(
      path.join(ocDir, 'extensions.json'),
      JSON.stringify({
        paths: ['E:\\repo\\extensions\\agy-quota'],
        capabilityGrants: { 'agy-quota': ['service'] },
      }),
      'utf8',
    );
    const readyStopped = await probeQuotaHealth({ state: 'stopped', port: 3000 }, { env });
    assert.equal(readyStopped.status, 'ready-stopped');

    // 5. Running OP unmounted
    const unmounted = await probeQuotaHealth(
      { state: 'running', port: 3000 },
      {
        env,
        probeOp: async () => ({ reachable: true, registered: false, ok: false, configured: false, error: null, planLabel: null, windows: null }),
      },
    );
    assert.equal(unmounted.status, 'op-unmounted');

    // 6. Running OP error
    const opError = await probeQuotaHealth(
      { state: 'running', port: 3000 },
      {
        env,
        probeOp: async () => ({ reachable: true, registered: true, ok: false, configured: true, error: 'HTTP 403', planLabel: null, windows: null }),
      },
    );
    assert.equal(opError.status, 'op-error');
    assert.equal(opError.op.error, 'HTTP 403');

    // 7. Running OP healthy + custom usageDropdownProviders missing ext-agy-quota
    fs.writeFileSync(
      path.join(ocDir, 'settings.json'),
      JSON.stringify({ usageDropdownProviders: ['claude'] }),
      'utf8',
    );
    const opOk = await probeQuotaHealth(
      { state: 'running', port: 3000 },
      {
        env,
        probeOp: async () => ({
          reachable: true,
          registered: true,
          ok: true,
          configured: true,
          error: null,
          planLabel: 'Google AI Ultra',
          windows: {
            'Gemini (5h)': { usedPercent: 6 },
            'Gemini (Weekly)': { usedPercent: 17 },
          },
        }),
      },
    );
    assert.equal(opOk.status, 'op-ok');
    assert.equal(opOk.inWorkStatus, false);
    assert.equal(formatQuotaWindowsSummary(opOk.op.windows), 'Gemini5h 剩94% · Gemini周 剩83%');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
