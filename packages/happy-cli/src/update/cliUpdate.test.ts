import { describe, expect, it, vi } from 'vitest';
import { cliInstallCommand, compareExactVersions, deriveCliUpdateState, deriveLocalCliUpdateSummary, fetchCliUpdateState, resolveCliUpdateCheckInterval, withCurrentCliUpdateState } from './cliUpdate';

const policy = (recommendedVersion: string | null, minimumVersion: string | null = null) => ({
  recommendedVersion, minimumVersion, checkedAt: 100, source: 'configured' as const,
});

describe('CLI update policy', () => {
  it('compares releases and prereleases strictly', () => {
    expect(compareExactVersions('0.2.67', '0.2.68')).toBe(-1);
    expect(compareExactVersions('0.2.68', '0.2.68')).toBe(0);
    expect(compareExactVersions('0.2.68-beta.1', '0.2.68')).toBe(-1);
    expect(compareExactVersions('0.2.68-beta.10', '0.2.68-beta.2')).toBe(1);
    expect(compareExactVersions('0.2.68+build.1', '0.2.68+build.2')).toBe(0);
    expect(compareExactVersions('0.2.68-01', '0.2.68')).toBeNull();
    expect(compareExactVersions('latest', '0.2.68')).toBeNull();
  });

  it('classifies required before available', () => {
    expect(deriveCliUpdateState('0.2.20', policy('0.2.68', '0.2.34'))?.status).toBe('required');
    expect(deriveCliUpdateState('0.2.50', policy('0.2.68', '0.2.34'))?.status).toBe('available');
    expect(deriveCliUpdateState('0.2.68', policy('0.2.68', '0.2.34'))?.status).toBe('current');
  });

  it('constructs only an exact fixed-package install command', () => {
    expect(cliInstallCommand('0.2.68')).toBe('npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@0.2.68');
    expect(cliInstallCommand('latest')).toBeNull();
    expect(cliInstallCommand('0.2.68+build.1')).toContain('@0.2.68+build.1');
  });

  it('separates an installed/daemon mismatch from an available package update', () => {
    const cliUpdate = deriveCliUpdateState('0.2.67', policy('0.2.68', '0.2.34'))!;
    expect(deriveLocalCliUpdateSummary('0.2.68', '0.2.67', cliUpdate)).toMatchObject({
      daemonMismatch: true,
      installedStatus: 'current',
      installCommand: null,
    });
    expect(deriveLocalCliUpdateSummary('0.2.67', '0.2.67', cliUpdate)).toMatchObject({
      daemonMismatch: false,
      installedStatus: 'available',
      targetVersion: '0.2.68',
    });
  });

  it('rejects unsafe update-check intervals', () => {
    expect(resolveCliUpdateCheckInterval('300000')).toBe(300000);
    expect(resolveCliUpdateCheckInterval('0')).toBe(6 * 60 * 60 * 1000);
    expect(resolveCliUpdateCheckInterval('-1')).toBe(6 * 60 * 60 * 1000);
    expect(resolveCliUpdateCheckInterval('6h')).toBe(6 * 60 * 60 * 1000);
  });

  it('clears a previous daemon generation policy when the current lookup has no result', () => {
    const stale = deriveCliUpdateState('0.1.0', policy('0.2.68', '0.2.34'))!;
    expect(withCurrentCliUpdateState({ status: 'running', cliUpdate: stale }, null)).toEqual({ status: 'running' });
  });

  it('fails open for old servers and rejects malformed policy data', async () => {
    const oldServer = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
    await expect(fetchCliUpdateState('https://relay.test', '0.2.67', oldServer)).resolves.toBeNull();
    const malformed = vi.fn(async () => new Response(JSON.stringify({
      recommendedVersion: 'latest', minimumVersion: null, checkedAt: 1, source: 'registry',
    }), { status: 200 })) as typeof fetch;
    await expect(fetchCliUpdateState('https://relay.test', '0.2.67', malformed)).resolves.toBeNull();
  });
});
