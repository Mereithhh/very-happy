import { describe, expect, it } from 'vitest';
import { CODEX_REWIND_CAPABILITY, DSH_CONTEXT_CAPABILITY } from '@slopus/happy-wire';
import { canRetryMessage, canRewindMessage, latestRetryTarget } from './rewindSupport';
import { isForkableFlavor } from './forkModel';
import { canOfferBtw } from './btwCommand';

/**
 * B-970: dsh's ACP server has no way to cut, rewind or fork its history
 * (deepseek-harness packages/acp/acp/src/index.ts registers only initialize /
 * session new·list·resume·close·set_config_option·prompt·cancel; its README
 * lists deletion and fork as unsupported). So a dsh session offers no edit /
 * delete / retry, no fork and no side question — never a button that does
 * nothing — even on a wrapper that advertises every other capability.
 */
describe('dsh sessions hide the actions dsh cannot do (B-970)', () => {
    const dsh = { metadata: { flavor: 'dsh', capabilities: [DSH_CONTEXT_CAPABILITY, CODEX_REWIND_CAPABILITY] } } as any;
    const prompt = { seq: 3 };

    it('no edit / delete / retry, on a prompt or on the latest reply', () => {
        expect(canRewindMessage(dsh, prompt, null)).toBe(false);
        const target = latestRetryTarget(dsh, [{ kind: 'user-text', localId: 'a' }]);
        expect(canRetryMessage(canRewindMessage(dsh, target as any, null), false, 'again')).toBe(false);
    });

    it('no fork and no /btw', () => {
        expect(isForkableFlavor('dsh')).toBe(false);
        expect(canOfferBtw(dsh)).toBe(false);
    });

    it('Claude and Codex keep them', () => {
        expect(canRewindMessage({ metadata: { flavor: 'claude' } } as any, prompt, null)).toBe(true);
        expect(canRewindMessage({ metadata: { flavor: 'codex', capabilities: [CODEX_REWIND_CAPABILITY] } } as any, prompt, null)).toBe(true);
        expect(isForkableFlavor('claude') && isForkableFlavor('codex')).toBe(true);
    });
});
