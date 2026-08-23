#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverDir = path.resolve(__dirname, '..');
const webDir = path.resolve(serverDir, '..', 'happy-web-v2');
const webDist = path.join(webDir, 'dist');
const output = path.join(serverDir, 'webapp');

const result = spawnSync('pnpm', ['exec', 'vite', 'build'], {
  cwd: webDir,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  throw new Error(`Expected Web V2 build at ${webDist}`);
}

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(webDist, output, { recursive: true });
console.log(`Bundled production Web V2 into ${output}`);
