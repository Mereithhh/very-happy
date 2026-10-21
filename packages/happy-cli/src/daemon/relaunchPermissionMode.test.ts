import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeClaudeOutboundMode, publishedRelaunchPermissionMode } from './relaunchPermissionMode';
import { sanitizeSpawnPermissionMode } from './spawnPermissionMode';

describe('B-696 automation wake keeps the published permission mode', () => {
    it('claude: the mode the last wrapper ran is forwarded', () => {
        expect(publishedRelaunchPermissionMode({ flavor: 'claude', permissionMode: 'bypassPermissions' })).toBe('bypassPermissions');
        expect(publishedRelaunchPermissionMode({ flavor: 'claude', permissionMode: 'acceptEdits' })).toBe('acceptEdits');
        expect(publishedRelaunchPermissionMode({ flavor: 'claude', permissionMode: 'plan' })).toBe('plan');
        // flavor absent = claude (pre-flavor sessions)
        expect(publishedRelaunchPermissionMode({ permissionMode: 'bypassPermissions' })).toBe('bypassPermissions');
    });

    it('claude values go through the outbound allowlist (yolo → bypass, unknown → default)', () => {
        expect(publishedRelaunchPermissionMode({ flavor: 'claude', permissionMode: 'yolo' })).toBe('bypassPermissions');
        expect(publishedRelaunchPermissionMode({ flavor: 'claude', permissionMode: 'dontAsk' })).toBe('default');
        expect(normalizeClaudeOutboundMode(undefined)).toBeNull();
    });

    it('no published mode → no flag (never the code default)', () => {
        expect(publishedRelaunchPermissionMode({ flavor: 'claude' })).toBeUndefined();
        expect(publishedRelaunchPermissionMode(undefined)).toBeUndefined();
        expect(publishedRelaunchPermissionMode({ flavor: 'claude', permissionMode: 42 })).toBeUndefined();
    });

    it('other flavors forward as-is; the argv allowlist still applies', () => {
        expect(publishedRelaunchPermissionMode({ flavor: 'codex', permissionMode: 'yolo' })).toBe('yolo');
        expect(publishedRelaunchPermissionMode({ flavor: 'codex' })).toBeUndefined();
        expect(sanitizeSpawnPermissionMode(publishedRelaunchPermissionMode({ flavor: 'codex', permissionMode: 'safe-yolo' }))).toBeNull();
    });

    it('wiring: the automation wake asks for it, explicit modes still win, the result reaches argv', () => {
        const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');
        const wake = run.slice(run.indexOf('wakeHibernated: async (id) => {'), run.indexOf('joinProject: (sessionId, projectId)'));
        expect(wake).toContain('await resumeSession(id, { keepPublishedPermissionMode: true });');
        const impl = run.slice(run.indexOf('const resumeSessionImpl = async'), run.indexOf('const restartCounts = new Map'));
        expect(impl).toMatch(/const requestedMode = options\?\.permissionMode\s+\?\? \(options\?\.keepPublishedPermissionMode \? publishedRelaunchPermissionMode\(metadata\) : undefined\);/);
        expect(impl).toContain('const permissionMode = sanitizeSpawnPermissionMode(requestedMode);');
        expect(impl).toContain("if (permissionMode) launch.args.push('--permission-mode', permissionMode);");
    });
});
