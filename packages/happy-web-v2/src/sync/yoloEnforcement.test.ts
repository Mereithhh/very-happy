import { describe, expect, it } from 'vitest';
import {
    decideYoloEnforcement,
    newPermissionRequests,
    resolveIntentSource,
    shouldAlignToBypass,
    type YoloEnforcementInput,
} from './yoloEnforcement';

const base: YoloEnforcementInput = {
    flavor: 'claude',
    variant: null,
    controlledByUser: false,
    presence: 'online',
    displayed: 'bypassPermissions',
    intentSource: 'local',
    capabilities: [],
    busy: false,
    request: { tool: 'Bash', kind: 'tool' },
};

describe('decideYoloEnforcement (B-262 A3)', () => {
    it('old wrapper without live-permission capability → bare allow', () => {
        expect(decideYoloEnforcement(base)).toBe('allow');
        expect(decideYoloEnforcement({ ...base, capabilities: ['claude-steer-v1'] })).toBe('allow');
    });
    it('0.2.89 (v1) and 0.2.90+ (v2) → one set-permission-mode RPC instead of per-card clicks', () => {
        expect(decideYoloEnforcement({ ...base, capabilities: ['claude-live-permission-v1'] })).toBe('rpc');
        expect(decideYoloEnforcement({ ...base, capabilities: ['claude-steer-v1', 'claude-live-permission-v1', 'claude-live-permission-v2'] })).toBe('rpc');
    });
    it('requests older than 0.2.79 carry no kind — treated as ordinary tools; elicitation/user_dialog never', () => {
        expect(decideYoloEnforcement({ ...base, request: { tool: 'Bash' } })).toBe('allow');
        expect(decideYoloEnforcement({ ...base, request: { tool: 'Bash', kind: null } })).toBe('allow');
        expect(decideYoloEnforcement({ ...base, request: { tool: 'AskUserQuestion', kind: 'elicitation' } })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, request: { tool: 'Bash', kind: 'user_dialog' } })).toBe('skip');
    });
    it('never auto-approves AskUserQuestion or ExitPlanMode even under yolo', () => {
        expect(decideYoloEnforcement({ ...base, request: { tool: 'AskUserQuestion', kind: 'tool' } })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, request: { tool: 'ExitPlanMode', kind: 'tool' } })).toBe('skip');
    });
    it('never enforces a code-default guess; only local / override / published intent', () => {
        expect(decideYoloEnforcement({ ...base, intentSource: 'codeDefault' })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, intentSource: 'override' })).toBe('allow');
        expect(decideYoloEnforcement({ ...base, intentSource: 'published' })).toBe('allow');
    });
    it('assistant sessions only when the mode was chosen locally', () => {
        expect(decideYoloEnforcement({ ...base, variant: 'assistant', intentSource: 'override' })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, variant: 'assistant', intentSource: 'local' })).toBe('allow');
    });
    it('skips non-claude flavors, mirrors, local-mode and unknown-control sessions', () => {
        expect(decideYoloEnforcement({ ...base, flavor: 'codex' })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, flavor: 'gemini' })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, flavor: 'terminal-mirror' })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, controlledByUser: true })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, controlledByUser: undefined })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, flavor: null })).toBe('allow'); // legacy sessions have no flavor
    });
    it('skips offline sessions, busy sessions and non-yolo intent', () => {
        expect(decideYoloEnforcement({ ...base, presence: 1700000000 })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, presence: null })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, busy: true })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, displayed: 'plan' })).toBe('skip');
        expect(decideYoloEnforcement({ ...base, displayed: 'yolo' })).toBe('allow');
    });
});

describe('resolveIntentSource', () => {
    it('published > local > override > codeDefault', () => {
        expect(resolveIntentSource({ published: 'default', local: 'bypassPermissions', override: 'plan' })).toBe('published');
        expect(resolveIntentSource({ published: null, local: 'bypassPermissions', override: 'plan' })).toBe('local');
        expect(resolveIntentSource({ published: undefined, local: null, override: 'plan' })).toBe('override');
        expect(resolveIntentSource({ published: undefined, local: null, override: undefined })).toBe('codeDefault');
    });
});

describe('shouldAlignToBypass (A6, upgrade-only)', () => {
    const align = {
        flavor: 'claude', controlledByUser: false, presence: 'online' as const, displayed: 'bypassPermissions',
        intentSource: 'local' as const, published: 'default', capabilities: ['claude-live-permission-v2'], hasPendingRequests: false, busy: false,
    };
    it('v2 online: align when published is not bypass', () => {
        expect(shouldAlignToBypass(align)).toBe(true);
        expect(shouldAlignToBypass({ ...align, published: 'bypassPermissions' })).toBe(false);
    });
    it('v1 only aligns while a request is pending; no capability never', () => {
        expect(shouldAlignToBypass({ ...align, capabilities: ['claude-live-permission-v1'] })).toBe(false);
        expect(shouldAlignToBypass({ ...align, capabilities: ['claude-live-permission-v1'], hasPendingRequests: true })).toBe(true);
        expect(shouldAlignToBypass({ ...align, capabilities: [] , hasPendingRequests: true })).toBe(false);
    });
    it('never downgrades and never acts on a code-default guess or while busy', () => {
        expect(shouldAlignToBypass({ ...align, displayed: 'plan' })).toBe(false);
        expect(shouldAlignToBypass({ ...align, intentSource: 'codeDefault' })).toBe(false);
        expect(shouldAlignToBypass({ ...align, intentSource: 'published' })).toBe(false);
        expect(shouldAlignToBypass({ ...align, busy: true })).toBe(false);
    });
});

describe('newPermissionRequests', () => {
    it('initial load treats every pending request as new', () => {
        expect(newPermissionRequests(undefined, { agentStateVersion: 3, requests: { r1: { tool: 'Bash' } } })).toEqual([{ id: 'r1', tool: 'Bash', kind: undefined }]);
    });
    it('only diffs when agentStateVersion advanced (stale fetch must not re-trigger)', () => {
        const old = { agentStateVersion: 10, requests: {} };
        expect(newPermissionRequests(old, { agentStateVersion: 9, requests: { r1: { tool: 'Bash' } } })).toEqual([]);
        expect(newPermissionRequests(old, { agentStateVersion: 10, requests: { r1: { tool: 'Bash' } } })).toEqual([]);
        expect(newPermissionRequests(old, { agentStateVersion: 11, requests: { r1: { tool: 'Bash', kind: 'tool' } } })).toEqual([{ id: 'r1', tool: 'Bash', kind: 'tool' }]);
    });
    it('ignores requests already present in the old state', () => {
        const old = { agentStateVersion: 1, requests: { r1: { tool: 'Bash' } } };
        expect(newPermissionRequests(old, { agentStateVersion: 2, requests: { r1: { tool: 'Bash' }, r2: { tool: 'Read' } } })).toEqual([{ id: 'r2', tool: 'Read', kind: undefined }]);
    });
});

describe('collectYoloDecisions (storage-side glue, pure)', () => {
    it('derives intent from metadata/local/override and skips code-default guesses', async () => {
        const { collectYoloDecisions } = await import('./yoloEnforcement');
        const base = {
            sessionId: 's1',
            metadata: { flavor: 'claude', capabilities: ['claude-live-permission-v2'] },
            controlledByUser: false,
            presence: 'online' as const,
            localMode: null,
            resolvedMode: null,
            overrides: {},
            busy: false,
            requests: [{ id: 'r1', tool: 'Bash', kind: 'tool' }],
        };
        expect(collectYoloDecisions(base)).toEqual([]); // codeDefault → skip
        expect(collectYoloDecisions({ ...base, overrides: { claude: { permissionMode: 'bypassPermissions' } } }))
            .toEqual([{ sessionId: 's1', requestId: 'r1', tool: 'Bash', action: 'rpc' }]);
        expect(collectYoloDecisions({ ...base, localMode: 'bypassPermissions', resolvedMode: 'bypassPermissions', metadata: { flavor: 'claude' } }))
            .toEqual([{ sessionId: 's1', requestId: 'r1', tool: 'Bash', action: 'allow' }]);
        expect(collectYoloDecisions({ ...base, localMode: 'plan', resolvedMode: 'plan' })).toEqual([]);
        expect(collectYoloDecisions({ ...base, metadata: { flavor: 'claude', permissionMode: 'bypassPermissions', capabilities: ['claude-live-permission-v2'] }, resolvedMode: 'bypassPermissions' }))
            .toEqual([{ sessionId: 's1', requestId: 'r1', tool: 'Bash', action: 'rpc' }]);
    });
});
