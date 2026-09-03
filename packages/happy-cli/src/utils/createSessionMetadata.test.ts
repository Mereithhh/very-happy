import { describe, expect, it } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { isValidSpawnOrigin, spawnOriginTags, createSessionMetadata } from './createSessionMetadata';

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/Developer',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('createSessionMetadata', () => {
    it('sets metadata.sandbox to the config when enabled', () => {
        const sandbox = createSandboxConfig();
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sandbox,
        });

        expect(metadata.sandbox).toEqual(sandbox);
    });

    it('sets metadata.sandbox to null when sandbox is disabled', () => {
        const sandbox = createSandboxConfig({ enabled: false });
        const { metadata } = createSessionMetadata({
            flavor: 'gemini',
            machineId: 'machine-2',
            startedBy: 'daemon',
            sandbox,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandbox is not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-3',
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions to null when not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-4',
        });

        expect(metadata.dangerouslySkipPermissions).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-5',
            dangerouslySkipPermissions: true,
        });

        expect(metadata.dangerouslySkipPermissions).toBe(true);
    });

    it('sets fork lineage metadata when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-6',
            parentSessionId: 'happy-source',
            forkedFromMessageId: 'message-2',
        });

        expect(metadata.parentSessionId).toBe('happy-source');
        expect(metadata.forkedFromMessageId).toBe('message-2');
    });
});

describe('spawnOriginTags (B-091, generalised in B-303)', () => {
    it("assistant-dispatched session → ['assistant'] (B-091 behaviour unchanged)", () => {
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'assistant' })).toEqual(['assistant']);
    });

    it('the assistant meta-agent itself is NOT tagged (it is the variant)', () => {
        expect(
            spawnOriginTags({ HAPPY_SPAWNED_BY: 'assistant', HAPPY_SESSION_VARIANT: 'assistant' }),
        ).toBeUndefined();
    });

    it('the variant gate wins over any origin, not just "assistant"', () => {
        expect(
            spawnOriginTags({ HAPPY_SPAWNED_BY: 'tanka', HAPPY_SESSION_VARIANT: 'assistant' }),
        ).toBeUndefined();
    });

    // B-303: the origin IS the tag. Before B-303 only the literal 'assistant'
    // produced one (so this used to assert `'user'` → undefined); external
    // adapters need the same legibility, and nothing but the assistant's own
    // session_spawn sets `spawnedBy` inside this repo, so widening it changes
    // no existing spawn path.
    it('any adapter origin becomes that session tag', () => {
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'tanka' })).toEqual(['tanka']);
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'cron-nightly' })).toEqual(['cron-nightly']);
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'user' })).toEqual(['user']);
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: '  tanka  ' })).toEqual(['tanka']);
    });

    it('un-set or blank origin gets no tags field at all (never an empty array)', () => {
        expect(spawnOriginTags({})).toBeUndefined();
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: '' })).toBeUndefined();
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: '   ' })).toBeUndefined();
    });

    it('a value that would render as a malformed chip yields no tag', () => {
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'Tanka' })).toBeUndefined();
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'tanka bridge' })).toBeUndefined();
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: '-leading-dash' })).toBeUndefined();
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: 'x'.repeat(25) })).toBeUndefined();
        expect(spawnOriginTags({ HAPPY_SPAWNED_BY: '<script>' })).toBeUndefined();
    });

    it('isValidSpawnOrigin mirrors the tag rule (shared with the CLI flag)', () => {
        expect(isValidSpawnOrigin('tanka')).toBe(true);
        expect(isValidSpawnOrigin('x'.repeat(24))).toBe(true);
        expect(isValidSpawnOrigin('Tanka')).toBe(false);
        expect(isValidSpawnOrigin('')).toBe(false);
    });
});
