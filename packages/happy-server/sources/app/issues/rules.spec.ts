import { describe, expect, it } from 'vitest';
import { redactIssueQuery, requestLogSerializer } from '@/app/api/clientIp';
import {
    attentionClosedByStatus, canonicalJson, decodeCursor, defaultMentionMachine, encodeCursor, issuesAccountAllowlist, issuesEnabled, issuesEnabledForAnyAccount, mentionItem, normalizeAssignee,
    planHumanUpdateRun, resolveRunDirectory, reviewItem, sameAgentConfig, searchNumber, splitList,
} from './rules';

const codex = { kind: 'agent', machineId: 'm1', agent: 'codex', directory: '/r' } as const;

describe('B-872 issue rules (pure)', () => {
    it('the global switch is on only for exactly "true", and then for every account', () => {
        delete process.env.VH_ISSUES_ACCOUNTS;
        for (const [value, on] of [[undefined, false], ['false', false], ['1', false], ['TRUE', false], ['true', true]] as const) {
            if (value === undefined) delete process.env.VH_ISSUES_ENABLED; else process.env.VH_ISSUES_ENABLED = value;
            expect(issuesEnabled('acct-a'), String(value)).toBe(on);
            expect(issuesEnabled('acct-b'), String(value)).toBe(on);
            expect(issuesEnabledForAnyAccount(), String(value)).toBe(on);
        }
        process.env.VH_ISSUES_ACCOUNTS = 'acct-a';
        expect(issuesEnabled('acct-b')).toBe(true);
        delete process.env.VH_ISSUES_ENABLED;
        delete process.env.VH_ISSUES_ACCOUNTS;
    });

    it('B-888 VH_ISSUES_ACCOUNTS: only listed accounts; spaces, blanks and duplicates tolerated; unset or blank is all off', () => {
        delete process.env.VH_ISSUES_ENABLED;
        for (const raw of [undefined, '', ' ', ',', ' , ,, ']) {
            if (raw === undefined) delete process.env.VH_ISSUES_ACCOUNTS; else process.env.VH_ISSUES_ACCOUNTS = raw;
            expect(issuesEnabled('acct-a'), JSON.stringify(raw)).toBe(false);
            expect(issuesEnabled(''), JSON.stringify(raw)).toBe(false);
            expect(issuesEnabledForAnyAccount(), JSON.stringify(raw)).toBe(false);
        }
        process.env.VH_ISSUES_ACCOUNTS = ' acct-a ,, acct-c,acct-a , ';
        expect(['acct-a', 'acct-b', 'acct-c', '', ' acct-a ', 'ACCT-A', 'acct'].map(id => issuesEnabled(id))).toEqual([true, false, true, false, false, false, false]);
        expect(issuesEnabledForAnyAccount()).toBe(true);
        expect([...issuesAccountAllowlist()]).toEqual(['acct-a', 'acct-c']);
        process.env.VH_ISSUES_ENABLED = 'false';
        expect(issuesEnabled('acct-a')).toBe(true);
        expect(issuesEnabled('acct-b')).toBe(false);
        // Re-read on every call: a changed value takes effect without a restart.
        process.env.VH_ISSUES_ACCOUNTS = 'acct-b';
        expect([issuesEnabled('acct-a'), issuesEnabled('acct-b')]).toEqual([false, true]);
        delete process.env.VH_ISSUES_ENABLED;
        delete process.env.VH_ISSUES_ACCOUNTS;
    });

    it('§3.1 run planning: agent + runnable only; changed agent supersedes; reopen without an active run starts', () => {
        const plan = (before: object, after: object, hasActiveRun = false) => planHumanUpdateRun({ before: before as never, after: after as never, hasActiveRun });
        expect(plan({ status: 'backlog', assignee: { kind: 'none' } }, { status: 'backlog', assignee: codex })).toEqual({ start: false });
        expect(plan({ status: 'backlog', assignee: codex }, { status: 'todo', assignee: codex })).toEqual({ start: true, supersede: false });
        expect(plan({ status: 'done', assignee: codex }, { status: 'todo', assignee: codex }, true)).toEqual({ start: false });
        expect(plan({ status: 'todo', assignee: codex }, { status: 'in_review', assignee: codex })).toEqual({ start: false });
        expect(plan({ status: 'todo', assignee: codex }, { status: 'todo', assignee: { ...codex, agent: 'claude' } })).toEqual({ start: true, supersede: true });
        expect(plan({ status: 'todo', assignee: codex }, { status: 'todo', assignee: { kind: 'self' } })).toEqual({ start: false });
        expect(plan({ status: 'todo', assignee: { kind: 'none' } }, { status: 'todo', assignee: codex })).toEqual({ start: true, supersede: true });
    });

    it('agent configuration equality ignores key order and undefined, not values', () => {
        expect(sameAgentConfig(codex, { directory: '/r', agent: 'codex', kind: 'agent', machineId: 'm1' } as never)).toBe(true);
        expect(sameAgentConfig(codex, { ...codex, model: 'gpt-5' })).toBe(false);
        expect(sameAgentConfig(codex, { ...codex, directory: '/other' })).toBe(false);
        expect(sameAgentConfig({ kind: 'none' }, { kind: 'none' })).toBe(false);
        expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: undefined }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2 }] }, b: 1 }));
        expect(normalizeAssignee({ kind: 'agent', machineId: 'm', agent: 'pi', model: undefined } as never)).toEqual({ kind: 'agent', machineId: 'm', agent: 'pi' });
    });

    it('directory: explicit > the project folder on that machine (primary first) > none; @ machine default', () => {
        const folders = [{ machineId: 'm2', path: '/a', primary: true }, { machineId: 'm1', path: '/b', primary: false }, { machineId: 'm1', path: '/c', primary: false }];
        expect(resolveRunDirectory('/x', folders, 'm1')).toBe('/x');
        expect(resolveRunDirectory(undefined, folders, 'm1')).toBe('/b');
        expect(resolveRunDirectory(undefined, folders, 'm2')).toBe('/a');
        expect(resolveRunDirectory(undefined, folders, 'm9')).toBeNull();
        expect(defaultMentionMachine(codex, folders)).toBe('m1');
        expect(defaultMentionMachine({ kind: 'none' }, folders)).toBe('m2');
        expect(defaultMentionMachine({ kind: 'self' }, [])).toBeNull();
    });

    it('§7 which items a status move closes', () => {
        expect(attentionClosedByStatus('in_review', 'todo')).toEqual({ review: true, blocked: false, all: false });
        expect(attentionClosedByStatus('blocked', 'in_progress')).toEqual({ review: false, blocked: true, all: false });
        expect(attentionClosedByStatus('in_progress', 'done')).toEqual({ review: true, blocked: true, all: true });
        expect(attentionClosedByStatus('todo', 'cancelled').all).toBe(true);
        expect(attentionClosedByStatus('in_review', 'in_review')).toEqual({ review: false, blocked: false, all: false });
    });

    it('attention items: issue link, keys per issue / comment, review options 完成 / 退回', () => {
        const issue = { id: 'i1', key: 'VH-12', title: 'Ship it' };
        expect(reviewItem(issue, 'tests green')).toMatchObject({
            source: 'issue', kind: 'decision', key: 'issue-review:i1', title: 'VH-12 待验收 · Ship it', bodyMd: 'tests green',
            options: [{ id: 'done', label: '完成' }, { id: 'return', label: '退回' }], links: [{ type: 'issue', ref: 'i1', label: 'VH-12' }],
        });
        expect(mentionItem(issue, { id: 'c1', body: '\n  Which DB?\nmore' })).toMatchObject({ kind: 'todo', key: 'issue-mention:c1', title: 'VH-12 @你 · Which DB?' });
        expect(reviewItem({ ...issue, title: 'x'.repeat(400) }, null).title.length).toBeLessThanOrEqual(200);
    });

    it('list helpers: cursor round-trip, comma lists, number search', () => {
        const c = encodeCursor({ updatedAt: new Date(1234), id: 'a:b' });
        expect(decodeCursor(c)).toEqual({ updatedAt: new Date(1234), id: 'a:b' });
        expect(decodeCursor('garbage')).toBeNull();
        expect(splitList('todo, done,,')).toEqual(['todo', 'done']);
        expect(splitList('')).toBeUndefined();
        expect([searchNumber('VH-12'), searchNumber('#3'), searchNumber('7'), searchNumber('fix 7')]).toEqual([12, 3, 7, null]);
    });

    it('request logs keep only the path of /v1/issues URLs (search text is issue content)', () => {
        expect(redactIssueQuery('/v1/issues?q=secret&limit=5')).toBe('/v1/issues?[redacted]');
        expect(redactIssueQuery('/v1/issues/VH-1')).toBe('/v1/issues/VH-1');
        expect(redactIssueQuery('/v1/projects?x=1')).toBe('/v1/projects?x=1');
        expect(requestLogSerializer({ method: 'GET', url: '/v1/issues?q=secret', headers: {}, socket: null } as never).url).toBe('/v1/issues?[redacted]');
    });
});
