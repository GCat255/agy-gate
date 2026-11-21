/**
 * Parse CLI arguments compatible with OpenCode v2 (`--version`, `serve`, `models`, `doctor`).
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  if (!argv || argv.length === 0) {
    return { command: 'help' };
  }

  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help' };
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    return { command: 'version' };
  }
  if (first === 'models') {
    return { command: 'models' };
  }
  if (first === 'doctor') {
    return { command: 'doctor' };
  }
  if (first === 'quota-login') {
    return { command: 'quota-login' };
  }
  if (first === 'quota-status') {
    return { command: 'quota-status' };
  }
  if (first === 'quota-logout') {
    return { command: 'quota-logout' };
  }
  if (first === 'mcp-bridge') {
    return { command: 'mcp-bridge' };
  }
  if (first === 'install-mcp') {
    return { command: 'install-mcp' };
  }
  if (first === 'setup') {
    let installDeps = false;
    let dryRun = false;
    let json = false;
    let uninstall = false;
    let skipMcp = false;
    let keepEngine = false;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--install-deps') installDeps = true;
      else if (arg === '--dry-run') dryRun = true;
      else if (arg === '--json') json = true;
      else if (arg === '--uninstall') uninstall = true;
      else if (arg === '--no-mcp') skipMcp = true;
      else if (arg === '--keep-engine') keepEngine = true;
    }
    return { command: 'setup', installDeps, dryRun, json, uninstall, skipMcp, keepEngine };
  }

  if (first === 'serve') {
    let stdio = false;
    let hostname = '127.0.0.1';
    let port = 0;

    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--stdio') {
        stdio = true;
      } else if (arg === '--hostname' && i + 1 < argv.length) {
        hostname = argv[++i];
      } else if (arg.startsWith('--hostname=')) {
        hostname = arg.slice('--hostname='.length);
      } else if (arg === '--port' && i + 1 < argv.length) {
        port = Number.parseInt(argv[++i], 10) || 0;
      } else if (arg.startsWith('--port=')) {
        port = Number.parseInt(arg.slice('--port='.length), 10) || 0;
      }
    }

    return { command: 'serve', stdio, hostname, port };
  }

  return { command: 'unknown', raw: first };
}
