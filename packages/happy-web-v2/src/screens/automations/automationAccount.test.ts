import { describe, expect, it } from 'vitest';
import type { Automation } from '@slopus/happy-wire';
import { actionFromDraft, buildUpdate, draftFromAutomation, editDraft, emptyDraft } from './automationForm';
import { attentionKind, attentionRank, describeAction } from './automationPresentation';

const spawnDraft = () => emptyDraft({ name: 'nightly', machineId: 'm1', triggerKind: 'interval', intervalEvery: '1h', actionKind: 'spawn', agent: 'claude', directory: '/w', prompt: 'p' });

describe('B-850e automation account', () => {
    it('the spawn action carries the pick (ref / null) and omits it when not chosen', () => {
        expect('agentProfile' in actionFromDraft(spawnDraft())).toBe(false);
        expect(actionFromDraft({ ...spawnDraft(), agentProfile: { id: 'org-a', label: 'Org A' } })).toMatchObject({ agentProfile: { id: 'org-a', label: 'Org A' } });
        expect(actionFromDraft({ ...spawnDraft(), agentProfile: null })).toMatchObject({ agentProfile: null });
    });

    it('changing the agent or the machine clears the account; other edits keep it', () => {
        const d = { ...spawnDraft(), agentProfile: { id: 'org-a' } };
        expect(editDraft(d, 'agent', 'codex').agentProfile).toBeUndefined();
        expect(editDraft(d, 'machineId', 'm2').agentProfile).toBeUndefined();
        expect(editDraft(d, 'agent', 'claude').agentProfile).toEqual({ id: 'org-a' });
        expect(editDraft(d, 'prompt', 'q').agentProfile).toEqual({ id: 'org-a' });
    });

    it('round-trips through an automation; changing only the account is a change', () => {
        const a = { id: 'a1', name: 'nightly', machineId: 'm1', trigger: { kind: 'interval', everyMs: 3_600_000 }, concurrency: 'skip', maxRuntimeMs: 21_600_000, version: 3,
            action: { kind: 'spawn', agent: 'claude', directory: '/w', prompt: 'p', sticky: { key: 'k' }, agentProfile: { id: 'org-b', label: 'Org B' } } } as unknown as Automation;
        const d = draftFromAutomation(a);
        expect(d.agentProfile).toEqual({ id: 'org-b', label: 'Org B' });
        expect(buildUpdate(d, a)).toMatchObject({ ok: true, changed: false });
        const moved = buildUpdate({ ...d, agentProfile: { id: 'org-a', label: 'Org A' } }, a);
        expect(moved).toMatchObject({ ok: true, changed: true, body: { action: { agentProfile: { id: 'org-a' } } } });
        const back = buildUpdate({ ...d, agentProfile: undefined }, a);
        expect(back.ok && back.body.action && 'agentProfile' in back.body.action).toBe(false);
    });

    it('account refusals are their own attention kinds, ranked with failures', () => {
        expect(attentionKind({ status: 'failed', attentionReason: 'account_unavailable' })).toBe('account_unavailable');
        expect(attentionKind({ status: 'failed', attentionReason: 'account_history_rejected' })).toBe('account_history_rejected');
        expect(attentionRank({ status: 'failed', attentionReason: 'account_unavailable' })).toBe(1);
    });

    it('the action headline names the account by the label the caller resolved', () => {
        const action = { kind: 'spawn', agent: 'claude', directory: '/w', prompt: 'p', agentProfile: { id: 'org-a', label: 'old' } } as const;
        expect(describeAction(action, 'zh', 'Org A').headline).toContain('账号 Org A');
        expect(describeAction({ ...action, agentProfile: undefined } as never, 'en', 'x').headline).not.toContain('account');
    });
});
