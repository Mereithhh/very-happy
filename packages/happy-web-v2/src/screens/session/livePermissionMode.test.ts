import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLAUDE_LIVE_PERMISSION_CAPABILITY, shouldApplyPermissionModeLive } from './livePermissionMode';

describe('shouldApplyPermissionModeLive', () => {
    it('uses the live RPC only for a running Claude session that advertises support', () => {
        expect(shouldApplyPermissionModeLive({
            isClaude: true,
            isWorking: true,
            isRemote: true,
            capabilities: [CLAUDE_LIVE_PERMISSION_CAPABILITY],
        })).toBe(true);
        expect(shouldApplyPermissionModeLive({
            isClaude: true,
            isWorking: false,
            isRemote: true,
            capabilities: [CLAUDE_LIVE_PERMISSION_CAPABILITY],
        })).toBe(false);
        expect(shouldApplyPermissionModeLive({
            isClaude: true,
            isWorking: true,
            isRemote: true,
            capabilities: ['claude-steer-v1'],
        })).toBe(false);
        expect(shouldApplyPermissionModeLive({
            isClaude: false,
            isWorking: true,
            isRemote: true,
            capabilities: [CLAUDE_LIVE_PERMISSION_CAPABILITY],
        })).toBe(false);
        expect(shouldApplyPermissionModeLive({
            isClaude: true,
            isWorking: true,
            isRemote: false,
            capabilities: [CLAUDE_LIVE_PERMISSION_CAPABILITY],
        })).toBe(false);
    });
});

describe('AgentInput live permission integration', () => {
    const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

    it('waits for the live RPC before committing the selected mode', () => {
        const rpc = source.indexOf('await sessionSetPermissionMode(sessionId, key)');
        const commit = source.indexOf("setMode('updateSessionPermissionMode', 'permissionMode', appliedKey)");
        expect(rpc).toBeGreaterThan(-1);
        expect(commit).toBeGreaterThan(rpc);
        expect(source).toContain("t('session.chat.permissionModeChangeFailed')");
    });
});
