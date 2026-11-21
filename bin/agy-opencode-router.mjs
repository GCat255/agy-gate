#!/usr/bin/env node
import process from 'node:process';

const COMMAND = process.argv[2] || 'help';

if (COMMAND === '--help' || COMMAND === '-h' || COMMAND === 'help') {
  process.stdout.write(
    [
      'agy-opencode-router — OpenChamber / OpenCode + agy-cli 分流网关',
      '',
      '用法：',
      '  agy-opencode-router --version',
      '  agy-opencode-router serve [--stdio] [--hostname <host>] [--port <port>]',
      '  agy-opencode-router models',
      '  agy-opencode-router doctor',
      '  agy-opencode-router --help',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

process.stderr.write(`agy-opencode-router 脚手架已就绪，子命令 "${COMMAND}" 正在实现中。\n`);
process.exit(1);
