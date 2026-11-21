#!/usr/bin/env node
import process from 'node:process';
import { runOccCli } from '../src/occ/app.mjs';

runOccCli(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stdout.write(`\nocc 出错：${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
