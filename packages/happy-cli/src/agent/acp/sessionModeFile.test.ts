import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeAcpPermissionMode,
  removeSessionModeFile,
  sessionModeFilePath,
  sessionModeFilePayload,
  writeSessionModeFile,
} from './sessionModeFile';

describe('normalizeAcpPermissionMode', () => {
  it('accepts the four Claude modes verbatim and yolo as an alias of bypassPermissions', () => {
    expect(normalizeAcpPermissionMode('default')).toBe('default');
    expect(normalizeAcpPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(normalizeAcpPermissionMode('plan')).toBe('plan');
    expect(normalizeAcpPermissionMode('bypassPermissions')).toBe('bypassPermissions');
    expect(normalizeAcpPermissionMode('yolo')).toBe('bypassPermissions');
  });

  it('rejects everything else', () => {
    expect(normalizeAcpPermissionMode('safe-yolo')).toBeNull();
    expect(normalizeAcpPermissionMode('read-only')).toBeNull();
    expect(normalizeAcpPermissionMode('')).toBeNull();
    expect(normalizeAcpPermissionMode(undefined)).toBeNull();
    expect(normalizeAcpPermissionMode({ permissionMode: 'yolo' })).toBeNull();
  });
});

describe('session mode file', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'vh-session-modes-')), 'session-modes');
  });
  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  it('places the file under <dir>/<happySessionId>.json with the documented payload', () => {
    expect(sessionModeFilePath('abc-123', dir)).toBe(join(dir, 'abc-123.json'));
    expect(sessionModeFilePayload('bypassPermissions', 1234)).toEqual({ permissionMode: 'bypassPermissions', updatedAt: 1234 });
  });

  it('writes 0600 JSON atomically (no temp file left behind) and overwrites on switch', () => {
    writeSessionModeFile('s1', 'bypassPermissions', { dir, now: 10 });
    const path = sessionModeFilePath('s1', dir);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissionMode: 'bypassPermissions', updatedAt: 10 });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(dir)).toEqual(['s1.json']);

    writeSessionModeFile('s1', 'default', { dir, now: 20 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissionMode: 'default', updatedAt: 20 });
  });

  it('removes the file on exit and tolerates a missing one', () => {
    writeSessionModeFile('s2', 'plan', { dir });
    removeSessionModeFile('s2', dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => removeSessionModeFile('s2', dir)).not.toThrow();
  });
});
