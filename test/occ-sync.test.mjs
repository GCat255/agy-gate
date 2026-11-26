import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRepoSync, inspectRepoSync, resolveSyncTarget } from '../src/occ/sync.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

function setupRepoFixture(tmp) {
  const bare = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const clone = path.join(tmp, 'clone');

  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--bare', '--initial-branch=main']);

  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'agy-gate', version: '0.1.0' }), 'utf8');
  fs.writeFileSync(path.join(seed, 'README.md'), 'v1\n', 'utf8');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'init']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '-u', 'origin', 'main']);

  git(tmp, ['clone', '--branch', 'main', bare, clone]);
  return { bare, seed, clone };
}

test('resolveSyncTarget detects linked, copied, and missing git repo modes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sync-target-'));
  try {
    const repo = path.join(tmp, 'repo');
    const copiedRoot = path.join(tmp, 'global-copy');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'agy-gate' }), 'utf8');
    fs.mkdirSync(copiedRoot, { recursive: true });
    fs.writeFileSync(path.join(copiedRoot, 'package.json'), JSON.stringify({ name: 'agy-gate' }), 'utf8');

    const linked = resolveSyncTarget({ routerRoot: repo, recordedRepoRoot: null });
    assert.equal(linked.ok, true);
    assert.equal(linked.installMode, 'linked');
    assert.equal(linked.repoRoot, repo);

    const copied = resolveSyncTarget({ routerRoot: copiedRoot, recordedRepoRoot: repo });
    assert.equal(copied.ok, true);
    assert.equal(copied.installMode, 'copied');
    assert.equal(copied.repoRoot, repo);

    const missing = resolveSyncTarget({ routerRoot: copiedRoot, recordedRepoRoot: null });
    assert.equal(missing.ok, false);
    assert.equal(missing.repoRoot, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('inspectRepoSync and applyRepoSync pull upstream commits and protect dirty trees', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sync-flow-'));
  try {
    const { seed, clone } = setupRepoFixture(tmp);

    const upToDate = await inspectRepoSync({ repoRoot: clone });
    assert.equal(upToDate.ok, true);
    assert.equal(upToDate.state, 'up-to-date');
    assert.equal(upToDate.branch, 'main');
    assert.equal(upToDate.behind, 0);

    // Push a new commit to bare remote from seed
    fs.writeFileSync(path.join(seed, 'README.md'), 'v2\n', 'utf8');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-m', 'feat: update readme']);
    git(seed, ['push', 'origin', 'main']);

    const behindInfo = await inspectRepoSync({ repoRoot: clone });
    assert.equal(behindInfo.ok, true);
    assert.equal(behindInfo.state, 'behind');
    assert.equal(behindInfo.behind, 1);
    assert.equal(behindInfo.commits.length, 1);
    assert.match(behindInfo.commits[0], /feat: update readme/);

    // Dirty working tree must block pull without overwriting local edits
    fs.writeFileSync(path.join(clone, 'README.md'), 'local-dirty\n', 'utf8');
    const dirtyInfo = await inspectRepoSync({ repoRoot: clone });
    assert.equal(dirtyInfo.ok, true);
    assert.equal(dirtyInfo.state, 'dirty');
    assert.equal(dirtyInfo.dirtyCount, 1);

    const blocked = await applyRepoSync({
      repoRoot: clone,
      branch: 'main',
      installMode: 'linked',
      runSetupFn: async () => ({ ok: true, warnings: [] }),
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /未提交修改/);

    // Clean working tree -> fast-forward pull succeeds and runs setup
    git(clone, ['checkout', '--', 'README.md']);
    let setupCalls = 0;
    let npmCalls = 0;
    const synced = await applyRepoSync({
      repoRoot: clone,
      branch: 'main',
      installMode: 'copied',
      execNpm: async () => {
        npmCalls += 1;
        return { ok: true, code: 0, out: '', err: '' };
      },
      runSetupFn: async () => {
        setupCalls += 1;
        return { ok: true, warnings: [] };
      },
    });
    assert.equal(synced.ok, true);
    assert.equal(synced.changed, true);
    assert.equal(synced.installSynced, true);
    assert.equal(npmCalls, 1);
    assert.equal(setupCalls, 1);
    assert.equal(fs.readFileSync(path.join(clone, 'README.md'), 'utf8').trim(), 'v2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
