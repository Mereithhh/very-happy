import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendPrivateFileSync, ensurePrivateDirectorySync, hardenPrivateDirectoryFilesSync, writePrivateFile } from './secureFiles';

describe.skipIf(process.platform === 'win32')('private local state permissions', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('hardens existing directories and files, not only newly created paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-modes-'));
    roots.push(root);
    chmodSync(root, 0o755);
    ensurePrivateDirectorySync(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);

    const state = join(root, 'access.key');
    await writePrivateFile(state, 'secret');
    chmodSync(state, 0o644);
    appendPrivateFileSync(state, '\nmore');
    expect(statSync(state).mode & 0o777).toBe(0o600);

    const oldLog = join(root, 'old.log');
    writeFileSync(oldLog, 'historical', { mode: 0o644 });
    hardenPrivateDirectoryFilesSync(root);
    expect(statSync(oldLog).mode & 0o777).toBe(0o600);
  });
});
