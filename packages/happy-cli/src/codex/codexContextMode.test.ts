import { describe, expect, it, vi } from 'vitest';
import { CodexContextModeController } from './codexContextMode';

const catalog = new Map([
    ['gpt-6.2-astra', { window: 272000, maxWindow: 872000, effectivePercent: 95 }],
    ['gpt-6.2-sol', { window: 500000, maxWindow: 872000, effectivePercent: 95 }],
    ['gpt-5.5', { window: 272000, maxWindow: 272000, effectivePercent: 95 }],
]);

describe('B-977 CodexContextModeController', () => {
    it('publishes the windows of models that can run larger, and the mode', () => {
        const publish = vi.fn();
        const modes = new CodexContextModeController('standard', publish);
        modes.setCatalog(catalog);
        expect(publish).toHaveBeenCalledWith({
            codexContextMode: 'standard',
            codexContextWindows: {
                'gpt-6.2-astra': { standard: 258400, extended: 828400 },
                'gpt-6.2-sol': { standard: 475000, extended: 828400 },
            },
        });
    });

    it('standard = Codex default said explicitly; extended asks for the catalog maximum; both compact at 90%', () => {
        const modes = new CodexContextModeController('standard', () => {});
        modes.setCatalog(catalog);
        expect(modes.configFor('gpt-6.2-astra')).toEqual({ model_context_window: 272000, model_auto_compact_token_limit: 244800 });
        expect(modes.configFor('gpt-6.2-sol')).toEqual({ model_context_window: 500000, model_auto_compact_token_limit: 450000 });
        expect(modes.pick('extended')).toBe(true);
        expect(modes.configFor('gpt-6.2-astra')).toEqual({ model_context_window: 872000, model_auto_compact_token_limit: 784800 });
        expect(modes.configFor('gpt-6.2-sol')).toEqual({ model_context_window: 872000, model_auto_compact_token_limit: 784800 });
        // A model that cannot run larger, or one the catalog does not know, keeps Codex's default.
        expect(modes.configFor('gpt-5.5')).toEqual({});
        expect(modes.configFor('custom-model')).toEqual({});
        expect(modes.configFor(undefined)).toEqual({});
    });

    it('a message pick changes the mode only for a known value, and says so once', () => {
        const publish = vi.fn();
        const modes = new CodexContextModeController('standard', publish);
        expect(modes.pick(undefined)).toBe(false);
        expect(modes.pick('1m')).toBe(false);
        expect(modes.pick('standard')).toBe(false);
        expect(publish).not.toHaveBeenCalled();
        expect(modes.pick('extended')).toBe(true);
        expect(publish).toHaveBeenLastCalledWith({ codexContextMode: 'extended' });
        expect(modes.current).toBe('extended');
    });
});

describe('B-977 default extended (Owner 11-26, #171)', () => {
    it('a new session on the default mode starts with the 872k window and the 90% compaction point (828,400 effective)', () => {
        const modes = new CodexContextModeController('extended', () => {});
        modes.setCatalog(catalog);
        expect(modes.configFor('gpt-6.2-astra')).toEqual({ model_context_window: 872000, model_auto_compact_token_limit: 784800 });
        expect(modes.configFor('gpt-6.2-sol')).toEqual({ model_context_window: 872000, model_auto_compact_token_limit: 784800 });
    });
    it('a model that cannot run larger, an unknown model or an empty catalog sends no window keys under the extended default', () => {
        const modes = new CodexContextModeController('extended', () => {});
        modes.setCatalog(catalog);
        expect(modes.configFor('gpt-5.5')).toEqual({});
        expect(modes.configFor('custom-model')).toEqual({});
        const empty = new CodexContextModeController('extended', () => {});
        empty.setCatalog(new Map());
        expect(empty.configFor('gpt-6.2-astra')).toEqual({});
    });
});

describe('B-977 a restarted wrapper keeps the session window (resume)', () => {
    it('an existing session restores its recorded level and its thread resumes with that window, not the new-session default', () => {
        // runCodex: resumedContextMode ?? (reconnect ? 'standard' : CODEX_CONTEXT_DEFAULT_MODE)
        const extended = new CodexContextModeController('extended', () => {});
        extended.setCatalog(catalog);
        expect(extended.configFor('gpt-6.2-astra')).toEqual({ model_context_window: 872000, model_auto_compact_token_limit: 784800 });
        const standard = new CodexContextModeController('standard', () => {});
        standard.setCatalog(catalog);
        expect(standard.configFor('gpt-6.2-astra')).toEqual({ model_context_window: 272000, model_auto_compact_token_limit: 244800 });
    });
});
