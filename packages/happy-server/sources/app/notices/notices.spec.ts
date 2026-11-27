import { describe, expect, it } from 'vitest';
import { parseInstanceConfig, type NoticeConfig } from '@/app/instance/instanceConfig';
import { noticesNeedUsername, visibleNotices } from './notices';

const notice = (over: Partial<NoticeConfig> & { id: string }): NoticeConfig => ({
    title: over.id, body: '', level: 'info', audience: 'all', dismissible: true, ...over,
});
const NOW = Date.parse('2026-11-27T12:00:00Z');
const viewer = { accountId: 'acct-a', username: 'ada' };

describe('visibleNotices', () => {
    it('filters by audience: all, account id, or username', () => {
        const list = [
            notice({ id: 'all' }),
            notice({ id: 'by-id', audience: { accounts: ['acct-a'] } }),
            notice({ id: 'by-name', audience: { accounts: ['ada'] } }),
            notice({ id: 'other', audience: { accounts: ['acct-b', 'bob'] } }),
        ];
        expect(visibleNotices(list, viewer, NOW).map(n => n.id).sort()).toEqual(['all', 'by-id', 'by-name']);
        expect(visibleNotices(list, { accountId: 'acct-a' }, NOW).map(n => n.id).sort()).toEqual(['all', 'by-id']);
        expect(noticesNeedUsername(list)).toBe(true);
        expect(noticesNeedUsername([notice({ id: 'x' })])).toBe(false);
    });

    it('shows a notice from startsAt (inclusive) until endsAt (exclusive)', () => {
        const list = [
            notice({ id: 'not-yet', startsAt: '2026-11-27T12:00:01Z' }),
            notice({ id: 'starts-now', startsAt: '2026-11-27T12:00:00Z' }),
            notice({ id: 'ended', endsAt: '2026-11-27T12:00:00Z' }),
            notice({ id: 'ends-later', endsAt: '2026-11-27T12:00:01Z' }),
        ];
        expect(visibleNotices(list, viewer, NOW).map(n => n.id)).toEqual(['starts-now', 'ends-later']);
    });

    it('orders newest first and never echoes the audience', () => {
        const list = [
            notice({ id: 'old', startsAt: '2026-11-01T00:00:00Z', audience: { accounts: ['acct-a'] } }),
            notice({ id: 'undated-1' }),
            notice({ id: 'new', startsAt: '2026-11-20T00:00:00Z', level: 'warning', dismissible: false, endsAt: '2026-12-01T00:00:00Z' }),
            notice({ id: 'undated-2' }),
        ];
        const out = visibleNotices(list, viewer, NOW);
        expect(out.map(n => n.id)).toEqual(['new', 'old', 'undated-2', 'undated-1']);
        expect(out[0]).toEqual({ id: 'new', title: 'new', body: '', level: 'warning', dismissible: false, startsAt: '2026-11-20T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' });
        expect(JSON.stringify(out)).not.toContain('audience');
    });
});

describe('notices section of the instance config', () => {
    it('applies defaults and drops invalid entries one by one, naming them', () => {
        const { config, problems } = parseInstanceConfig(JSON.stringify({
            notices: [
                { id: 'ok', title: 'Hello', body: 'Body' },
                { id: 'bad level', title: 'x' },
                { id: 'no-title', body: 'x' },
                { id: 'backwards', title: 'x', startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' },
                { id: 'bad-time', title: 'x', startsAt: 'tomorrow' },
                { id: 'ok', title: 'Duplicate' },
                { id: 'targeted', title: 'T', level: 'warning', audience: { accounts: ['acct-a'] }, dismissible: false },
            ],
            modelFeedback: { enabled: true },
        }), {});
        expect(config.notices).toEqual([
            { id: 'ok', title: 'Hello', body: 'Body', level: 'info', audience: 'all', dismissible: true },
            { id: 'targeted', title: 'T', body: '', level: 'warning', audience: { accounts: ['acct-a'] }, dismissible: false },
        ]);
        expect(config.modelFeedback).toMatchObject({ enabled: true });
        expect(problems).toHaveLength(5);
        expect(problems[0]).toMatch(/^notices\[#1\] dropped: id/);
        expect(problems[1]).toMatch(/^notices\["no-title"\] dropped: title/);
        expect(problems[2]).toMatch(/^notices\["backwards"\] dropped: endsAt/);
        expect(problems[3]).toMatch(/^notices\["bad-time"\] dropped: startsAt/);
        expect(problems[4]).toBe('notices["ok"] dropped: duplicate id');
    });

    it('a non-array section is no notices, and the list is capped', () => {
        expect(parseInstanceConfig(JSON.stringify({ notices: { id: 'x' } }), {})).toMatchObject({ config: { notices: [] }, problems: ['notices: must be an array'] });
        const many = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, title: 't' }));
        const { config, problems } = parseInstanceConfig(JSON.stringify({ notices: many }), {});
        expect(config.notices).toHaveLength(50);
        expect(problems).toEqual(['notices: 60 entries, only the first 50 are used']);
    });
});
