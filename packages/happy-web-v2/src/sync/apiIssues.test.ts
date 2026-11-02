import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://test.invalid' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test' }));

import { ISSUE_CONFLICT_MAX_RETRIES, issueConflictBackoffMs, issuesApi, setIssuesRetrySleep, setIssuesTransport, type IssuesTransport } from './apiIssues';

const ok = { issue: { id: 'i1' }, version: 1 };

afterEach(() => { setIssuesTransport(null); setIssuesRetrySleep(null); });

describe('issues API: 409 transaction_conflict retry (spec §9 B-872c)', () => {
    it('resends create / comment / PATCH / run / import with the same body (same requestId) until it succeeds', async () => {
        const sleeps: number[] = [];
        setIssuesRetrySleep(async (ms) => { sleeps.push(ms); });
        const calls = [
            () => issuesApi.create({ title: 'x', requestId: 'new-1' } as any),
            () => issuesApi.comment('i1', { body: 'hi', requestId: 'c-1' } as any),
            () => issuesApi.update('i1', { status: 'done', ifVersion: 3 } as any),
            () => issuesApi.run('i1', { requestId: 'r-1' } as any),
            () => issuesApi.importLegacyTodos(),
        ];
        for (const call of calls) {
            sleeps.length = 0;
            const seen: string[] = [];
            let n = 0;
            const transport = vi.fn<IssuesTransport>(async (method, path, body) => {
                seen.push(`${method} ${path} ${JSON.stringify(body)}`);
                return ++n <= 2 ? { status: 409, data: { error: 'transaction_conflict' } } : { status: 200, data: ok };
            });
            setIssuesTransport(transport);
            await expect(call()).resolves.toEqual(ok);
            expect(transport).toHaveBeenCalledTimes(3);
            expect(new Set(seen).size).toBe(1);
            expect(sleeps).toHaveLength(2);
            expect(sleeps[0]).toBeGreaterThanOrEqual(200);
            expect(sleeps[1]).toBeGreaterThanOrEqual(400);
        }
        expect(issueConflictBackoffMs(0, () => 0)).toBe(200);
        expect(issueConflictBackoffMs(3, () => 0.5)).toBe(2000);
    });

    it('gives up after 5 retries with the transaction_conflict error (issueErrors.ts copy is the fallback)', async () => {
        setIssuesRetrySleep(async () => {});
        const transport = vi.fn<IssuesTransport>(async () => ({ status: 409, data: { error: 'transaction_conflict' } }));
        setIssuesTransport(transport);
        await expect(issuesApi.create({ title: 'x', requestId: 'new-1' } as any)).rejects.toMatchObject({ status: 409, code: 'transaction_conflict' });
        expect(transport).toHaveBeenCalledTimes(1 + ISSUE_CONFLICT_MAX_RETRIES);
    });

    it('never retries other 409s', async () => {
        const sleep = vi.fn(async () => {});
        setIssuesRetrySleep(sleep);
        for (const code of ['issue_version_conflict', 'issue_status_forbidden', 'attention_item_stale']) {
            const transport = vi.fn<IssuesTransport>(async () => ({ status: 409, data: { error: code } }));
            setIssuesTransport(transport);
            await expect(issuesApi.update('i1', { status: 'done', ifVersion: 1 } as any)).rejects.toMatchObject({ status: 409, code });
            expect(transport).toHaveBeenCalledTimes(1);
        }
        expect(sleep).not.toHaveBeenCalled();
    });
});
