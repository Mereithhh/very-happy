import { isLatestModelMode } from '@slopus/happy-wire';
import { normalizeAgentKey } from './agentDefaults';

/**
 * B-971: where the model a Codex session runs comes from, so the picker can
 * say who chose it — this session's own pick, the account's new-session
 * default, the session's account, or the machine's Codex config — and say
 * when a new-session default hides a model the machine's config.toml pins.
 *
 * `configuredModel` is the wrapper's report (session metadata, or the
 * launcher's machine context for a draft). On an account it is the account's
 * model, not the machine config's, so nothing is said to be overridden there.
 */
export type CodexModelSource =
    | { kind: 'session' }
    | { kind: 'newSessionDefault'; model: string; overriddenConfig: string | null }
    | { kind: 'account' }
    | { kind: 'config'; model: string }
    | { kind: 'latest' }
    | { kind: 'none' };

export function codexModelSource(input: {
    flavor: string | null | undefined;
    /** This session's (or draft's) own pick; `latest` = it picked 「跟随最新」. */
    explicitModelMode: string | null | undefined;
    /** The account's new-session default for Codex (settings). */
    defaultModelMode: string | null | undefined;
    configuredModel: string | null | undefined;
    onAccount: boolean;
}): CodexModelSource {
    if (normalizeAgentKey(input.flavor) !== 'codex') return { kind: 'none' };
    const configured = typeof input.configuredModel === 'string' && input.configuredModel.trim() ? input.configuredModel.trim() : null;
    if (input.explicitModelMode && !isLatestModelMode(input.explicitModelMode)) return { kind: 'session' };
    const pinnedDefault = !input.explicitModelMode && input.defaultModelMode && !isLatestModelMode(input.defaultModelMode) && input.defaultModelMode !== 'default'
        ? input.defaultModelMode
        : null;
    if (pinnedDefault) {
        return {
            kind: 'newSessionDefault',
            model: pinnedDefault,
            overriddenConfig: !input.onAccount && configured && configured !== pinnedDefault ? configured : null,
        };
    }
    if (input.onAccount) return { kind: 'account' };
    return configured ? { kind: 'config', model: configured } : { kind: 'latest' };
}
