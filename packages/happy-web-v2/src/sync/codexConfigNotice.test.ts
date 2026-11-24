import { describe, expect, it } from 'vitest';
import { codexConfigNotice, codexModelSource, readCodexConfigReadError } from './codexModelSource';
import { MetadataSchema } from './storageTypes';
import { followLatestDescriptionKey } from './followLatestDisplay';

/**
 * B-971b: the picker's note about this machine's own Codex config. A 0.2.227+
 * wrapper reports `machineConfigModel` / `configReadError` next to
 * `configuredModel` (which on an account is the account's model).
 */
const LEGACY = 'failed to resolve feature override precedence: legacy `profile = "ds"` config is no longer supported; use `--profile ds` with `ds.config.toml` instead';

function notice(metadata: Record<string, unknown>, opts: { onAccount: boolean; explicitModelMode?: string | null; defaultModelMode?: string | null; flavor?: string }) {
    const source = codexModelSource({
        flavor: opts.flavor ?? 'codex',
        explicitModelMode: opts.explicitModelMode ?? null,
        defaultModelMode: opts.defaultModelMode ?? null,
        configuredModel: metadata.configuredModel as string | null | undefined,
        onAccount: opts.onAccount,
    });
    return codexConfigNotice({ source, configuredModel: metadata.configuredModel as string | null | undefined, machineConfigModel: metadata.machineConfigModel as string | null | undefined, configReadError: metadata.configReadError });
}

describe('B-971b Codex machine-config notice', () => {
    it('account session: account model differs from the machine config → says both', () => {
        expect(notice({ configuredModel: 'gpt-6.1-terra', machineConfigModel: 'deepseek-v4-flash' }, { onAccount: true }))
            .toEqual({ kind: 'accountOverridesConfig', accountModel: 'gpt-6.1-terra', machineModel: 'deepseek-v4-flash' });
    });

    it('account session: same model, or the config pins nothing → no notice', () => {
        expect(notice({ configuredModel: 'gpt-6.1-terra', machineConfigModel: 'gpt-6.1-terra' }, { onAccount: true })).toBeNull();
        expect(notice({ configuredModel: 'gpt-6.1-terra', machineConfigModel: null }, { onAccount: true })).toBeNull();
    });

    it('account session where this session picked its own model → it is not the account\'s, no notice', () => {
        expect(notice({ configuredModel: 'gpt-6.1-terra', machineConfigModel: 'deepseek-v4-flash' }, { onAccount: true, explicitModelMode: 'gpt-6.2-sol' })).toBeNull();
    });

    it('non-account session: machineConfigModel equals configuredModel → no notice', () => {
        expect(notice({ configuredModel: 'deepseek-v4-flash', machineConfigModel: 'deepseek-v4-flash' }, { onAccount: false })).toBeNull();
    });

    it('old CLI (neither field) → no notice, account or not', () => {
        expect(notice({ configuredModel: 'gpt-6.1-terra' }, { onAccount: true })).toBeNull();
        expect(notice({ configuredModel: 'deepseek-v4-flash' }, { onAccount: false })).toBeNull();
        expect(notice({}, { onAccount: false })).toBeNull();
    });

    it('legacy profile → read failure with the reason and the profile to fix (account or not)', () => {
        const error = { kind: 'legacyProfile', reason: LEGACY };
        expect(notice({ configReadError: error }, { onAccount: false })).toEqual({ kind: 'configReadFailed', reason: LEGACY, legacyProfile: 'ds' });
        expect(notice({ configuredModel: 'gpt-6.1-terra', configReadError: error }, { onAccount: true })).toEqual({ kind: 'configReadFailed', reason: LEGACY, legacyProfile: 'ds' });
    });

    it('other read failure → reason only, no profile fix', () => {
        expect(notice({ configReadError: { kind: 'invalidConfig', reason: 'invalid configuration: invalid type: integer `…`, expected a string in `model`' } }, { onAccount: false }))
            .toEqual({ kind: 'configReadFailed', reason: 'invalid configuration: invalid type: integer `…`, expected a string in `model`', legacyProfile: null });
    });

    it('not Codex → nothing', () => {
        expect(notice({ configReadError: { kind: 'failed', reason: 'x' } }, { onAccount: false, flavor: 'claude' })).toBeNull();
    });

    it('reads an unknown error shape defensively', () => {
        expect(readCodexConfigReadError({ kind: 'future', reason: 'a\nb' })).toEqual({ kind: 'failed', reason: 'a' });
        expect(readCodexConfigReadError({ kind: 'legacyProfile' })).toBeNull();
        expect(readCodexConfigReadError('nope')).toBeNull();
    });

    it('metadata schema keeps the new fields and a bad shape never drops the metadata', () => {
        const parsed = MetadataSchema.parse({ path: '/w', host: 'h', configuredModel: 'a', machineConfigModel: 'b', configReadError: { kind: 'legacyProfile', reason: LEGACY } });
        expect(parsed.machineConfigModel).toBe('b');
        expect(parsed.configReadError).toEqual({ kind: 'legacyProfile', reason: LEGACY });
        const odd = MetadataSchema.safeParse({ path: '/w', host: 'h', machineConfigModel: 5, configReadError: 7 });
        expect(odd.success).toBe(true);
        expect(odd.success && odd.data.machineConfigModel).toBeUndefined();
    });

    it('follow subtitle: a failed config/read is not called an old CLI', () => {
        const state = { kind: 'machineDefault' } as const;
        expect(followLatestDescriptionKey(state)).toBe('session.chat.modelLatestDescriptionUpgradeCli');
        expect(followLatestDescriptionKey(state, { configReadFailed: true })).toBe('session.chat.modelLatestDescriptionConfigReadFailed');
        expect(followLatestDescriptionKey({ kind: 'machineConfig', model: 'a' } as any, { configReadFailed: true })).toBe('session.chat.modelLatestDescription');
    });
});
