#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const activePublicFiles = [
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'docs/security.md',
  'packages/happy-cli/README.md',
  'packages/happy-cli/CLAUDE.md',
  'packages/happy-server/README.md',
  'packages/happy-agent/README.md',
  'packages/happy-cli/src/api/apiMachine.ts',
  'packages/happy-server/sources/app/api/socket/terminalHandler.ts',
  'packages/happy-web-v2/src/sync/ops.ts',
];

const forbiddenClaims = [
  /zero-knowledge encryption architecture/i,
  /have no ability to decrypt or read/i,
  /we cannot read your code or conversations/i,
  /all machine and session data is end-to-end encrypted/i,
  /all data encrypted before leaving the device/i,
  /encryption keys never leave your device/i,
  /same encryption as Signal/i,
  /relay can't read/i,
  /relay cannot read/i,
  /E2E guarantee/i,
  /already E2E-encrypted/i,
];

const failures = [];
for (const relative of activePublicFiles) {
  const content = readFileSync(resolve(root, relative), 'utf8');
  for (const claim of forbiddenClaims) {
    if (claim.test(content)) failures.push(`${relative}: forbidden trust claim ${claim}`);
  }
}

const privacy = readFileSync(resolve(root, 'PRIVACY.md'), 'utf8');
for (const required of ['server-trusted architecture', 'not end-to-end', 'recover account secrets']) {
  if (!privacy.includes(required)) failures.push(`PRIVACY.md: missing required disclosure "${required}"`);
}

for (const archived of [
  'packages/happy-app/CLAUDE.md',
  'packages/happy-app/Stores.md',
  'packages/happy-app/docs/marketing/README-creators.md',
]) {
  const content = readFileSync(resolve(root, archived), 'utf8');
  if (!content.slice(0, 700).toLowerCase().includes('archived')) {
    failures.push(`${archived}: missing prominent archived disclaimer`);
  }
}

if (failures.length) {
  console.error('Trust-model contract check failed:\n' + failures.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log('Trust-model contract check passed.');
