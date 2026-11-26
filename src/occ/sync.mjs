import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROUTER_ROOT } from '../core/config.mjs';
import { resolveNpmInvocation } from '../core/process.mjs';
import { runSetup } from '../cli/setup.mjs';
import { readRecordedRepoRoot, runCapture, tail } from './services.mjs';

function sameRealDir(a, b) {
  try {
    return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase();
  } catch {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
}

function isAgyGateGitRepo(dir) {
  if (!dir) return false;
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg?.name === 'agy-gate';
  } catch {
    return false;
  }
}

/**
 * Resolve the local `agy-gate` git repository and whether global CLI is symlinked or copied.
 * @param {{ routerRoot?: string, recordedRepoRoot?: string | null, env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveSyncTarget(options = {}) {
  const env = options.env || process.env;
  const routerRoot = path.resolve(options.routerRoot || ROUTER_ROOT);
  const recorded = options.recordedRepoRoot !== undefined
    ? options.recordedRepoRoot
    : readRecordedRepoRoot(env);

  const candidates = [routerRoot];
  if (recorded && path.resolve(recorded) !== routerRoot) {
    candidates.push(path.resolve(recorded));
  }

  for (const dir of candidates) {
    if (isAgyGateGitRepo(dir)) {
      return {
        ok: true,
        repoRoot: dir,
        installMode: sameRealDir(dir, routerRoot) ? 'linked' : 'copied',
      };
    }
  }

  return {
    ok: false,
    repoRoot: null,
    installMode: 'copied',
    error: '未找到本地 Git 仓库，请先 git clone 仓库并在目录内运行一次安装脚本。',
  };
}

function createDefaultGitRunner(env = process.env) {
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  return (repoRoot, args, timeoutMs = 15000) => runCapture('git', args, timeoutMs, gitEnv, repoRoot);
}

function createDefaultNpmRunner(env = process.env) {
  const npm = resolveNpmInvocation(env);
  return (repoRoot, args, timeoutMs = 300000) =>
    runCapture(npm.file, [...npm.prefixArgs, ...args], timeoutMs, env, repoRoot);
}

function summarizeErr(res, fallback) {
  return tail(res?.err || res?.out, 2).join(' ') || fallback;
}

/**
 * Inspect local git status and fetch upstream updates from GitHub (`origin`) without mutating files.
 * @param {{
 *   repoRoot?: string,
 *   routerRoot?: string,
 *   recordedRepoRoot?: string | null,
 *   remote?: string,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   execGit?: (repoRoot: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean, code: number, out: string, err: string }>,
 * }} [options]
 */
export async function inspectRepoSync(options = {}) {
  const env = options.env || process.env;
  const remote = options.remote || 'origin';
  const timeoutMs = options.timeoutMs ?? 15000;
  const execGit = options.execGit || createDefaultGitRunner(env);

  let target;
  if (options.repoRoot) {
    const root = path.resolve(options.repoRoot);
    target = isAgyGateGitRepo(root)
      ? { ok: true, repoRoot: root, installMode: options.installMode || 'linked' }
      : { ok: false, repoRoot: null, installMode: 'copied', error: '未找到有效的 agy-gate Git 仓库' };
  } else {
    target = resolveSyncTarget({
      routerRoot: options.routerRoot,
      recordedRepoRoot: options.recordedRepoRoot,
      env,
    });
  }

  if (!target.ok) {
    return { ok: false, state: 'no-repo', ...target, error: target.error };
  }

  const { repoRoot, installMode } = target;
  const verRes = await execGit(repoRoot, ['--version'], 5000);
  if (!verRes.ok) {
    return {
      ok: false,
      state: 'no-git',
      repoRoot,
      installMode,
      error: '未检测到 git 命令，请先安装 Git。',
    };
  }

  const [shaRes, branchRes, remoteRes, statusRes] = await Promise.all([
    execGit(repoRoot, ['rev-parse', '--short', 'HEAD'], 5000),
    execGit(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], 5000),
    execGit(repoRoot, ['remote', 'get-url', remote], 5000),
    execGit(repoRoot, ['status', '--porcelain'], 5000),
  ]);

  const shortSha = shaRes.ok ? shaRes.out.trim() : null;
  const branch = branchRes.ok ? branchRes.out.trim() : null;
  const remoteUrl = remoteRes.ok ? remoteRes.out.trim() : null;
  const dirtyFiles = statusRes.ok
    ? statusRes.out.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
    : [];
  const dirtyCount = dirtyFiles.length;

  if (!branch) {
    return {
      ok: false,
      state: 'detached',
      repoRoot,
      installMode,
      branch: null,
      shortSha,
      remoteUrl,
      dirtyCount,
      ahead: 0,
      behind: 0,
      commits: [],
      error: '当前处于游离 HEAD 状态，请先切换到 main 等分支后再同步。',
    };
  }

  if (!remoteUrl) {
    return {
      ok: false,
      state: 'no-remote',
      repoRoot,
      installMode,
      branch,
      shortSha,
      remoteUrl: null,
      dirtyCount,
      ahead: 0,
      behind: 0,
      commits: [],
      error: `未配置远程仓库 ${remote}。`,
    };
  }

  const fetchRes = await execGit(repoRoot, ['fetch', '--prune', remote], timeoutMs);
  if (!fetchRes.ok) {
    return {
      ok: false,
      state: 'offline',
      repoRoot,
      installMode,
      branch,
      shortSha,
      remoteUrl,
      dirtyCount,
      ahead: 0,
      behind: 0,
      commits: [],
      error: `无法连接远程仓库：${summarizeErr(fetchRes, 'git fetch 失败')}`,
    };
  }

  const upstreamRef = `${remote}/${branch}`;
  const verifyRes = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', upstreamRef], 5000);
  if (!verifyRes.ok) {
    return {
      ok: false,
      state: 'no-upstream',
      repoRoot,
      installMode,
      branch,
      shortSha,
      remoteUrl,
      dirtyCount,
      ahead: 0,
      behind: 0,
      commits: [],
      error: `远程不存在分支 ${upstreamRef}。`,
    };
  }

  const countsRes = await execGit(repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`], 5000);
  const parts = countsRes.out.trim().split(/\s+/);
  const ahead = Number.parseInt(parts[0] || '0', 10) || 0;
  const behind = Number.parseInt(parts[1] || '0', 10) || 0;

  let commits = [];
  if (behind > 0) {
    const logRes = await execGit(repoRoot, ['log', '--oneline', '-n', '8', `HEAD..${upstreamRef}`], 5000);
    if (logRes.ok) {
      commits = logRes.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }

  let state = 'up-to-date';
  if (dirtyCount > 0) state = 'dirty';
  else if (ahead > 0 && behind > 0) state = 'diverged';
  else if (behind > 0) state = 'behind';
  else if (ahead > 0) state = 'ahead';

  return {
    ok: true,
    state,
    repoRoot,
    installMode,
    branch,
    shortSha,
    remoteUrl,
    dirtyCount,
    ahead,
    behind,
    commits,
    error: null,
  };
}

/**
 * Pull fast-forward updates from GitHub, refresh global install if copied, and re-run `setup`.
 * @param {{
 *   repoRoot: string,
 *   branch: string,
 *   installMode?: 'linked' | 'copied',
 *   remote?: string,
 *   env?: NodeJS.ProcessEnv,
 *   execGit?: (repoRoot: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean, code: number, out: string, err: string }>,
 *   execNpm?: (repoRoot: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean, code: number, out: string, err: string }>,
 *   runSetupFn?: typeof runSetup,
 * }} options
 */
export async function applyRepoSync(options) {
  const env = options.env || process.env;
  const repoRoot = path.resolve(options.repoRoot);
  const branch = options.branch;
  const remote = options.remote || 'origin';
  const installMode = options.installMode || 'linked';
  const execGit = options.execGit || createDefaultGitRunner(env);
  const execNpm = options.execNpm || createDefaultNpmRunner(env);
  const runSetupFn = options.runSetupFn || runSetup;

  const statusRes = await execGit(repoRoot, ['status', '--porcelain'], 5000);
  const dirty = statusRes.ok
    ? statusRes.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  if (dirty.length > 0) {
    return {
      ok: false,
      beforeSha: null,
      afterSha: null,
      changed: false,
      installSynced: false,
      setupResult: null,
      error: `工作区存在 ${dirty.length} 处未提交修改，已中止同步以防覆盖。`,
    };
  }

  const beforeRes = await execGit(repoRoot, ['rev-parse', '--short', 'HEAD'], 5000);
  const beforeSha = beforeRes.ok ? beforeRes.out.trim() : null;

  const pullRes = await execGit(repoRoot, ['pull', '--ff-only', remote, branch], 60000);
  if (!pullRes.ok) {
    return {
      ok: false,
      beforeSha,
      afterSha: beforeSha,
      changed: false,
      installSynced: false,
      setupResult: null,
      error: `git pull --ff-only 失败：${summarizeErr(pullRes, '请先手动解决分支分叉')}`,
    };
  }

  const afterRes = await execGit(repoRoot, ['rev-parse', '--short', 'HEAD'], 5000);
  const afterSha = afterRes.ok ? afterRes.out.trim() : beforeSha;
  const changed = Boolean(beforeSha && afterSha && beforeSha !== afterSha);

  let installSynced = false;
  if (installMode === 'copied') {
    const npmRes = await execNpm(repoRoot, ['install', '-g', '.'], 300000);
    if (!npmRes.ok) {
      return {
        ok: false,
        beforeSha,
        afterSha,
        changed,
        installSynced: false,
        setupResult: null,
        error: `代码已拉取到 ${afterSha}，但同步全局命令失败：${summarizeErr(npmRes, 'npm install -g . 失败')}`,
      };
    }
    installSynced = true;
  }

  const cliEntryPath = path.join(repoRoot, 'bin', 'agy-gate.mjs');
  const setupResult = await runSetupFn({
    cliEntryPath,
    routerRoot: repoRoot,
    env,
  });

  return {
    ok: Boolean(setupResult?.ok),
    beforeSha,
    afterSha,
    changed,
    installSynced,
    setupResult,
    error: setupResult?.ok ? null : (setupResult?.warnings?.[0] || '环境配置刷新未完全成功'),
  };
}
