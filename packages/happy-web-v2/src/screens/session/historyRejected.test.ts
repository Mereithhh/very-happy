import { describe, expect, it } from 'vitest';
import { historyRejectedFor, historyRejectedLabel, newSessionAccountFor } from './historyRejected';
import type { Message } from '@/sync/typesMessage';

const event = (createdAt: number, kind: string, message = `This conversation's history cannot continue on account "Hub". Start a new session on it, or switch back to the previous account.`) =>
    ({ kind: 'agent-event', id: `e${createdAt}`, createdAt, event: { type: 'message', message, kind } }) as unknown as Message;
const reply = (createdAt: number) => ({ kind: 'agent-text', id: `t${createdAt}`, createdAt, text: 'ok' }) as unknown as Message;
const onHub = { id: 'hub', label: 'Hub', kind: 'codex-provider', status: 'active' as const };

describe('B-850c2 history-rejected banner', () => {
    it('reads the account from the CLI line', () => {
        expect(historyRejectedLabel('… on account "LLM Hub". …')).toBe('LLM Hub');
        expect(historyRejectedLabel('something else')).toBeNull();
    });

    it('shows while the refusal is the latest word for the account the session is on', () => {
        expect(historyRejectedFor([reply(1), event(2, 'agent-profile-history-rejected')], onHub)).toEqual({ at: 2, label: 'Hub' });
        // a reply after it: the session went on
        expect(historyRejectedFor([event(2, 'agent-profile-history-rejected'), reply(3)], onHub)).toBeNull();
        // switched since (back or elsewhere)
        expect(historyRejectedFor([event(2, 'agent-profile-history-rejected')], { ...onHub, id: 'gpt', label: 'me@x.com' })).toBeNull();
        expect(historyRejectedFor([event(2, 'agent-profile-history-rejected')], null)).toBeNull();
        expect(historyRejectedFor([event(2, 'agent-profile-history-rejected')], { ...onHub, status: 'unavailable' })).toBeNull();
        // other events are not it
        expect(historyRejectedFor([event(2, 'agent-profile-auth-failed')], onHub)).toBeNull();
        // an unparsable line still shows (cannot tell the account apart)
        expect(historyRejectedFor([event(2, 'agent-profile-history-rejected', 'rejected')], onHub)).toEqual({ at: 2, label: null });
    });
});

describe('B-850c2 新开会话 account', () => {
    const accounts = [{ id: 'fake', label: 'Fake', agent: 'codex' }, { id: 'c-fake', label: 'Fake', agent: 'claude' }, { id: 'hub', label: 'Hub', agent: 'codex' }];
    it('starts on the account that refused, even after switching back', () => {
        expect(newSessionAccountFor('Fake', accounts, 'codex', { ...onHub })).toBe('fake');
        // unknown / renamed: what runs now; machine login = null
        expect(newSessionAccountFor('Gone', accounts, 'codex', onHub)).toBe('hub');
        expect(newSessionAccountFor(null, accounts, 'codex', null)).toBeNull();
    });
});
