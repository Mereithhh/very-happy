/**
 * B-604: an approved plan must hand the composer back to the mode Claude
 * really runs in, not leave it parked on 「计划模式」.
 *
 * Mechanism (probed against Claude Code 2.1.296 / SDK 0.3.296, 2026-10-15):
 * in bypassPermissions the model may call EnterPlanMode on its own — it never
 * reaches canUseTool, the SDK only emits `system/status permissionMode:"plan"`,
 * which the CLI does not republish. The web flips its local mode to `plan`
 * when it sees the EnterPlanMode tool call (storage.applyMessages). After the
 * user approves ExitPlanMode the SDK restores bypass, the CLI's published
 * metadata.permissionMode never moved (still bypassPermissions), so
 * resolveSessionPermissionMode keeps the local `plan` forever — and the next
 * message carries meta.permissionMode=plan, which really puts Claude in plan.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { NormalizedMessage } from './typesRaw';
import { resolvePlanExitPermissionMode } from './sessionModeSync';
import { resolveMessageModeMeta } from './messageMeta';

let storage: typeof import('./storage').storage;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('./storage'));
});

const NOW = 1_700_000_000_000;

type Completed = { tool: string; status: 'approved' | 'denied' | 'canceled'; mode?: string | null };

function session(agentStateVersion: number, agentState: Record<string, unknown> | null, publishedMode = 'bypassPermissions') {
    return {
        id: 's1', seq: 1, createdAt: NOW, updatedAt: NOW + agentStateVersion, active: true, activeAt: NOW,
        metadata: { machineId: 'm1', path: '/repo', flavor: 'claude', permissionMode: publishedMode, capabilities: ['claude-live-permission-v2'] },
        metadataVersion: 1, agentState, agentStateVersion, thinking: true, thinkingAt: NOW,
    } as never;
}

function toolCall(name: string, seq: number): NormalizedMessage {
    return {
        id: `msg-${seq}`, localId: null, createdAt: NOW + seq, seq, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-call', id: `tool-${seq}`, name, input: {}, description: null, uuid: `u-${seq}`, parentUUID: null }],
    } as NormalizedMessage;
}

const exitRequest = { tool: 'ExitPlanMode', arguments: { plan: 'p' }, createdAt: NOW };
const completed = (c: Completed) => ({ ...exitRequest, completedAt: NOW + 1, ...c });

describe('approved plan restores the composer mode (B-604, storage path)', () => {
    beforeEach(() => {
        storage.setState({ sessions: {}, sessionMessages: {} } as never);
    });

    function enterPlanWhileYolo() {
        storage.getState().applySessions([session(1, { requests: {} })]);
        storage.getState().updateSessionPermissionMode('s1', 'bypassPermissions');
        storage.getState().applyMessages('s1', [toolCall('EnterPlanMode', 1)]);
        expect(storage.getState().sessions.s1.permissionMode).toBe('plan');
        storage.getState().applyMessages('s1', [toolCall('ExitPlanMode', 2)]);
        storage.getState().applySessions([session(2, { requests: { r1: exitRequest } })]);
    }

    it('follows the approved ExitPlanMode back to yolo even though published mode never changed', () => {
        enterPlanWhileYolo();
        storage.getState().applySessions([session(3, { requests: {}, completedRequests: { r1: completed({ tool: 'ExitPlanMode', status: 'approved', mode: 'bypassPermissions' }) } })]);
        const s = storage.getState().sessions.s1;
        expect(s.permissionMode).toBe('bypassPermissions');
        expect(resolveMessageModeMeta(s).permissionMode).toBe('bypassPermissions');
    });

    it('a rejected plan keeps plan mode (Claude is still planning)', () => {
        enterPlanWhileYolo();
        storage.getState().applySessions([session(3, { requests: {}, completedRequests: { r1: completed({ tool: 'ExitPlanMode', status: 'denied' }) } })]);
        expect(storage.getState().sessions.s1.permissionMode).toBe('plan');
    });
});

describe('resolvePlanExitPermissionMode', () => {
    const prev = { r0: completed({ tool: 'ExitPlanMode', status: 'approved', mode: 'acceptEdits' }) };

    it('mirrors the CLI follow-up mode of a newly approved plan', () => {
        expect(resolvePlanExitPermissionMode({ previous: {}, next: { r1: completed({ tool: 'ExitPlanMode', status: 'approved', mode: 'acceptEdits' }) }, mode: 'plan' })).toBe('acceptEdits');
        expect(resolvePlanExitPermissionMode({ previous: {}, next: { r1: completed({ tool: 'exit_plan_mode', status: 'approved', mode: 'default' }) }, mode: 'plan' })).toBe('default');
        // CLI: no / plan / unknown mode on approval → bypassPermissions
        expect(resolvePlanExitPermissionMode({ previous: {}, next: { r1: completed({ tool: 'ExitPlanMode', status: 'approved' }) }, mode: 'plan' })).toBe('bypassPermissions');
        expect(resolvePlanExitPermissionMode({ previous: {}, next: { r1: completed({ tool: 'ExitPlanMode', status: 'approved', mode: 'plan' }) }, mode: 'plan' })).toBe('bypassPermissions');
    });

    it('ignores already-seen, unknown-baseline, non-plan, rejected and other-tool completions', () => {
        expect(resolvePlanExitPermissionMode({ previous: prev, next: prev, mode: 'plan' })).toBeNull();
        expect(resolvePlanExitPermissionMode({ previous: undefined, next: prev, mode: 'plan' })).toBeNull();
        expect(resolvePlanExitPermissionMode({ previous: {}, next: prev, mode: 'default' })).toBeNull();
        expect(resolvePlanExitPermissionMode({ previous: {}, next: { r1: completed({ tool: 'ExitPlanMode', status: 'denied' }) }, mode: 'plan' })).toBeNull();
        expect(resolvePlanExitPermissionMode({ previous: {}, next: { r1: completed({ tool: 'Bash', status: 'approved', mode: 'default' }) }, mode: 'plan' })).toBeNull();
    });
});
