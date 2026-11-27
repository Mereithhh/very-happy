/**
 * B-981: a session on a global model channel is tagged whenever tagging is
 * configured, even if the channel's host is not in `hosts`; a machine-local
 * account on the same host is not. Plus the runClaude wiring (source assertion,
 * verified with scripts/dev/mutation-check.mjs).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeGlobalChannels } from '@/agentProfiles/globalAccounts';
import { writeAccountsFile } from '@/agentProfiles/store';
import { loadWrapperAccount } from '@/agentProfiles/wrapperAccount';
import { startClaudeRequestTagging } from './claudeTagging';

const config = { sessionHeader: 'X-Test-Session', requestHeader: 'X-Test-Request', hosts: ['listed.example.com'] };
const ok = async () => new Response(JSON.stringify({ modelRequestTagging: config }), { status: 200 });
const KEY = ['sk', 'channel', 'test'].join('-');

describe('B-981 tagging of global channel sessions', () => {
    it('global channel → tagged regardless of hosts; same host as a local account → not tagged', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'vh-b981-tag-'));
        materializeGlobalChannels(dir, { revision: 'r', channels: [{ id: 'gw', label: 'GW', agent: 'claude', baseUrl: 'https://unlisted.example.com', models: ['m'], apiKey: KEY }] });
        writeAccountsFile(dir, { version: 2, accounts: { mine: { label: 'Mine', agent: 'claude', kind: 'claude-api', createdAt: 1, baseUrl: 'https://unlisted.example.com', key: { source: 'file', path: join(dir, 'global-accounts', 'gw', 'secret') } } }, defaults: {} });

        const env: NodeJS.ProcessEnv = { PATH: '/bin' };
        const account = loadWrapperAccount(dir, 's-global', 'global-gw', env);
        expect(account.global).toBe(true);
        const tagger = await startClaudeRequestTagging({ env, sessionId: 's-global', serverUrl: 'http://server', token: 't', happyHome: dir, accountUsable: !account.unavailable, alwaysTag: account.global === true, fetch: ok as any });
        try {
            expect(tagger).not.toBeNull();
            expect(env.ANTHROPIC_BASE_URL).toBe(tagger!.baseUrl);
        } finally {
            await tagger?.close();
        }

        const localEnv: NodeJS.ProcessEnv = { PATH: '/bin' };
        const local = loadWrapperAccount(dir, 's-local', 'mine', localEnv);
        expect(local.global).toBeUndefined();
        expect(await startClaudeRequestTagging({ env: localEnv, sessionId: 's-local', serverUrl: 'http://server', token: 't', happyHome: dir, accountUsable: true, alwaysTag: local.global === true, fetch: ok as any })).toBeNull();
        expect(localEnv.ANTHROPIC_BASE_URL).toBe('https://unlisted.example.com');
    });

    it('runClaude passes the account\'s global flag as alwaysTag', () => {
        const src = readFileSync(new URL('../claude/runClaude.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        expect(src).toContain('alwaysTag: input.account.global === true,');
    });
});
