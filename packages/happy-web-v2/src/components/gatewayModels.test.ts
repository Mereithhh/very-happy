import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import {
    CLAUDE_GATEWAY_MODELS,
    gatewayModelsAllowed,
    getAvailableModels,
    getClaudeModelModes,
    getDefaultModelKey,
    getHardcodedModelModes,
    getLauncherModelModes,
    withGatewayModelsFor,
} from './modelModeOptions';
import { layoutModelPicker } from '@/screens/session/modelPickerLayout';
import { localizeModelDescriptions } from '@/screens/session/runSetupCopy';
import { contextWindowFor, LONG_CONTEXT_WINDOW } from '@/screens/session/contextWindow';
import { spawnClaudeAccount } from '@/sync/agentProfiles';
import { CHANGELOG_RELEASES } from '@/app/changelogRelease';

/**
 * B-968 (Owner 11-24): Kimi K3.1 Pro and DeepSeek V4.1 Flash in the default
 * Claude model list — after every existing entry, defaults untouched, hidden
 * only where the account is known to be Anthropic's own.
 */
const GATEWAY = ['kimi-k3.1-pro', 'deepseek-v4.1-flash'];
// sessionAccount pulls in the text runtime, which needs browser globals first.
let sessionClaudeAccount: typeof import('@/screens/session/sessionAccount').sessionClaudeAccount;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sessionClaudeAccount } = await import('@/screens/session/sessionAccount'));
});
const t = ((key: string) => key) as never;
const keys = (models: { key: string }[]) => models.map((m) => m.key);

/** The Claude code list as origin/main shipped it before B-968 (order is part of the contract). */
const CLAUDE_BEFORE = [
    'default', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-2', 'claude-fable-5-2[1m]',
    'claude-fable-5-1', 'claude-fable-5-1[1m]', 'fable', 'fable[1m]', 'best', 'opus', 'opus[1m]',
    'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5', 'sonnet', 'sonnet[1m]', 'haiku', 'opusplan',
];

describe('B-968: gateway models in the default Claude list', () => {
    it('appends both to the Claude code list; the existing order and the default stay', () => {
        expect(keys(getClaudeModelModes())).toEqual([...CLAUDE_BEFORE, ...GATEWAY]);
        expect(keys(CLAUDE_GATEWAY_MODELS)).toEqual(GATEWAY);
        expect(CLAUDE_GATEWAY_MODELS.map((m) => m.name)).toEqual(['Kimi K3.1 Pro', 'DeepSeek V4.1 Flash']);
        expect(getDefaultModelKey('claude')).toBe('latest'); // origin/main default (follow latest), unchanged
    });

    it('reaches the launcher, the team member dropdown and a live session; no other harness', () => {
        expect(keys(getLauncherModelModes('claude', [], t))).toEqual(expect.arrayContaining(GATEWAY));
        expect(keys(getHardcodedModelModes('claude', t))).toEqual(expect.arrayContaining(GATEWAY));
        const catalog = { models: [{ code: 'default', value: 'Default' }, { code: 'sonnet', value: 'Sonnet' }] };
        expect(keys(getAvailableModels('claude', catalog as never, t))).toEqual(['default', 'sonnet', ...GATEWAY]);
        for (const flavor of ['codex', 'gemini', 'pi', 'openclaw']) {
            expect(keys(getHardcodedModelModes(flavor, t))).not.toEqual(expect.arrayContaining([GATEWAY[0]]));
            expect(keys(getAvailableModels(flavor, catalog as never, t))).not.toContain(GATEWAY[1]);
        }
    });

    it('a catalog that already lists one keeps a single row', () => {
        const catalog = { models: [{ code: 'default', value: 'Default' }, { code: 'kimi-k3.1-pro', value: 'kimi' }] };
        expect(keys(getAvailableModels('claude', catalog as never, t))).toEqual(['default', 'kimi-k3.1-pro', 'deepseek-v4.1-flash']);
    });

    it('hides them only for an account known to be Anthropic’s own', () => {
        expect(gatewayModelsAllowed(null)).toBe(true);
        expect(gatewayModelsAllowed(undefined)).toBe(true);
        expect(gatewayModelsAllowed({ kind: 'claude-subscription' })).toBe(false);
        expect(gatewayModelsAllowed({ kind: 'claude-api', baseUrl: null })).toBe(false);
        expect(gatewayModelsAllowed({ kind: 'claude-api', baseUrl: '' })).toBe(false);
        expect(gatewayModelsAllowed({ kind: 'claude-api', baseUrl: 'https://api.anthropic.com' })).toBe(false);
        expect(gatewayModelsAllowed({ kind: 'claude-api', baseUrl: 'https://gateway.example.test/v1' })).toBe(true);
        expect(gatewayModelsAllowed({ kind: 'claude-api', baseUrl: 'https://anthropic.com.example.test' })).toBe(true);
        const list = getClaudeModelModes();
        expect(keys(withGatewayModelsFor(list, { kind: 'claude-subscription' }))).toEqual(CLAUDE_BEFORE);
        expect(withGatewayModelsFor(list, null)).toBe(list);
    });

    it('reads the account from a session binding and from a new session’s resolved account', () => {
        const state = { accounts: [
            { id: 'gw', agent: 'claude', kind: 'claude-api', label: 'GW', status: 'ok', baseUrl: 'https://gateway.example.test' },
            { id: 'off', agent: 'claude', kind: 'claude-api', label: 'Official', status: 'ok' },
        ], defaults: {} };
        const facts = (profile: unknown) => ({ agent: 'claude', machineId: 'm', machineName: 'm', state, profile, capable: true, online: true }) as never;
        expect(sessionClaudeAccount(null)).toBeNull();
        expect(sessionClaudeAccount(facts(null))).toBeNull();
        expect(sessionClaudeAccount(facts({ id: 'sub', label: 'S', kind: 'claude-subscription', status: 'active' }))).toEqual({ kind: 'claude-subscription' });
        expect(sessionClaudeAccount(facts({ id: 'gw', label: 'GW', kind: 'claude-api', status: 'active' }))).toEqual({ kind: 'claude-api', baseUrl: 'https://gateway.example.test' });
        expect(sessionClaudeAccount(facts({ id: 'off', label: 'O', kind: 'claude-api', status: 'active' }))).toEqual({ kind: 'claude-api', baseUrl: null });
        // An API binding whose endpoint the machine did not report is unknown, not Anthropic.
        expect(sessionClaudeAccount(facts({ id: 'gone', label: 'G', kind: 'claude-api', status: 'active' }))).toBeNull();

        expect(spawnClaudeAccount(null)).toBeNull();
        expect(spawnClaudeAccount({ kind: 'machine', explicit: true })).toBeNull();
        expect(spawnClaudeAccount({ kind: 'unsupported' })).toBeNull();
        expect(spawnClaudeAccount({ kind: 'account', account: state.accounts[0] as never, status: 'ok' as never, fromDefault: false }))
            .toEqual({ kind: 'claude-api', baseUrl: 'https://gateway.example.test' });
    });

    it('sits in the top list after the family picks, with the gateway description', () => {
        const options = getClaudeModelModes();
        const layout = layoutModelPicker(options, { flavor: 'claude', selectedKey: 'default' });
        const primary = keys(layout.primary);
        expect(primary.slice(-2)).toEqual(GATEWAY);
        expect(keys(layout.more)).not.toContain(GATEWAY[0]);
        const described = localizeModelDescriptions('claude', options, { keep: new Set(), translate: t });
        for (const key of GATEWAY) expect(described.find((m) => m.key === key)?.description).toBe('session.chat.modelPicker.desc.gateway');
    });

    it('knows their 1M context window; other non-Claude ids stay unknown', () => {
        expect(contextWindowFor('kimi-k3.1-pro')).toBe(LONG_CONTEXT_WINDOW);
        expect(contextWindowFor('deepseek-v4.1-flash')).toBe(LONG_CONTEXT_WINDOW);
        expect(contextWindowFor('kimi-k3')).toBeNull();
        expect(contextWindowFor('deepseek-v4.1-flash-1017')).toBeNull();
    });

    it('has a Web release note (nov24d)', () => {
        const note = CHANGELOG_RELEASES.find((r) => r.titleKey === 'changelog.releases.nov24d.title');
        expect(note?.cliVersion).toBeUndefined();
        expect(note?.itemKeys).toContain('changelog.releases.nov24d.tools');
    });
});
