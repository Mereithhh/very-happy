import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_REMOTE_PERMISSION_MODES, codexLaunchPublishablePermissionMode, codexPublishablePermissionMode } from './codexPermissionMode';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { publishedRelaunchPermissionMode } from '@/daemon/relaunchPermissionMode';
import { sanitizeSpawnPermissionMode } from '@/daemon/spawnPermissionMode';
import type { PermissionMode } from '@/api/types';

describe('B-845 Codex publishes the permission mode a resume relaunches with', () => {
    it('publishes Codex modes, nothing else', () => {
        for (const mode of ['default', 'read-only', 'safe-yolo', 'yolo']) expect(codexPublishablePermissionMode(mode)).toBe(mode);
        expect(codexPublishablePermissionMode('bypassPermissions')).toBeNull();
        expect(codexPublishablePermissionMode('totally_unsafe')).toBeNull();
        expect(codexPublishablePermissionMode(undefined)).toBeNull();
    });

    it('wiring: the explicit flag and every accepted message mode are published; the code default is not', () => {
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        expect(source).toContain('    publishPermissionMode(codexLaunchPublishablePermissionMode(opts.permissionMode));');
        expect(source).not.toContain('publishPermissionMode(initialPermissionMode)');
        expect(source).toContain([
            '                    messagePermissionMode = incoming;',
            '                    currentPermissionMode = messagePermissionMode;',
            '                    publishPermissionMode(incoming);',
        ].join('\n'));
        expect(source).toContain("session.updateMetadata((currentMetadata) => ({ ...currentMetadata, permissionMode: publishable }));");
    });
});

describe('B-845 Codex /clear re-sends the full project prefix', () => {
    it('resets the project injector in the /clear branch', () => {
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        const clear = source.slice(source.indexOf('if (isCodexClearText(message.message)) {'), source.indexOf("messageBuffer.addMessage('Context was reset', 'status');"));
        expect(clear).toContain('projectInjector.reset();');
    });
});

describe('B-845b Codex abort keeps the permission mode (published == actual)', () => {
    it('resetCurrentModeDefaults leaves currentPermissionMode alone', () => {
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        const start = source.indexOf('const resetCurrentModeDefaults = () => {');
        const reset = source.slice(start, source.indexOf('};', start));
        expect(reset).toContain("logger.debug('[Codex] Reset current mode defaults after abort');");
        expect(reset).not.toMatch(/currentPermissionMode\s*=/);
        // The only writes: an accepted message mode and the live set-permission-mode RPC (B-867c);
        // both are published right after.
        expect(source.match(/currentPermissionMode\s*=(?!=)/g)).toHaveLength(2);
        expect(source).toContain('currentPermissionMode = mode;\n        publishPermissionMode(mode);');
    });
});

describe('B-884 a Codex wrapper launched with bypassPermissions relaunches with the same access', () => {
    /** The daemon's restart / resume argv mode for a session's published metadata. */
    const relaunchFlag = (metadata: { flavor: string; permissionMode?: unknown }) =>
        sanitizeSpawnPermissionMode(publishedRelaunchPermissionMode(metadata));

    it('the launch flag publishes bypassPermissions as yolo; other flags as before', () => {
        expect(codexLaunchPublishablePermissionMode('bypassPermissions')).toBe('yolo');
        for (const mode of ['default', 'read-only', 'safe-yolo', 'yolo']) expect(codexLaunchPublishablePermissionMode(mode)).toBe(mode);
        for (const mode of ['acceptEdits', 'plan', 'totally_unsafe', undefined, null, 1]) expect(codexLaunchPublishablePermissionMode(mode)).toBeNull();
    });

    it('launch → publish → daemon relaunch flag → the same execution policy as the original launch', () => {
        const published = codexLaunchPublishablePermissionMode('bypassPermissions');
        const flag = relaunchFlag({ flavor: 'codex', permissionMode: published });
        expect(flag).toBe('yolo');
        for (const managed of [false, true]) {
            expect(resolveCodexExecutionPolicy(flag as PermissionMode, managed)).toEqual(resolveCodexExecutionPolicy('bypassPermissions', managed));
        }
        expect(resolveCodexExecutionPolicy(flag as PermissionMode, false)).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
        // Before B-884 nothing was published, so the relaunch carried no flag and ran `default`.
        expect(relaunchFlag({ flavor: 'codex' })).toBeNull();
    });

    it('remote message meta and the live RPC still cannot reach bypassPermissions (issue #1092)', () => {
        expect(CODEX_REMOTE_PERMISSION_MODES).toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
        expect(CODEX_REMOTE_PERMISSION_MODES).not.toContain('bypassPermissions');
        expect(codexPublishablePermissionMode('bypassPermissions')).toBeNull();
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        // The launch mapping is used exactly once, on the wrapper's own flag.
        expect(source.match(/codexLaunchPublishablePermissionMode\(/g)).toHaveLength(1);
        expect(source).toContain('if (VALID_REMOTE_PERMISSION_MODES.includes(incoming)) {');
        expect(source).toContain('const VALID_REMOTE_PERMISSION_MODES = CODEX_REMOTE_PERMISSION_MODES;');
        expect(source).toContain('const mode = codexPublishablePermissionMode(request?.mode);');
        // publishPermissionMode re-checks the Codex allowlist whatever it is handed.
        expect(source).toContain('const publishable = codexPublishablePermissionMode(mode);');
    });

    it('Claude relaunch is unchanged: bypassPermissions stays bypassPermissions, yolo maps to it', () => {
        expect(relaunchFlag({ flavor: 'claude', permissionMode: 'bypassPermissions' })).toBe('bypassPermissions');
        expect(relaunchFlag({ flavor: 'claude', permissionMode: 'yolo' })).toBe('bypassPermissions');
        expect(relaunchFlag({ flavor: 'claude', permissionMode: 'read-only' })).toBe('default');
        const claude = readFileSync(join(__dirname, '..', 'claude', 'runClaude.ts'), 'utf8');
        expect(claude).not.toContain('codexLaunchPublishablePermissionMode');
    });
});
