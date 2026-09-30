import { describe, expect, it } from 'vitest';
import type { MessageMeta } from '@/api/types';
import { withAssistantDenylist } from '@/assistant/dispatcherTools';
import type { ClaudeEffort, EnhancedMode, PermissionMode } from './loop';
import { resolveMessageMode, type ClaudeModeState } from './messageMode';
import { resolveRemoteClaudePermissionMode } from './utils/permissionMode';

/**
 * The pre-B-515 inline logic of runClaude.ts onUserMessage, ported verbatim
 * (logging dropped, `current*` variables folded into one state object). It is
 * the parity oracle: resolveMessageMode must produce the same mode, the same
 * sticky state and the same publish decision for every case below.
 */
function legacyResolve(state: ClaudeModeState, meta: MessageMeta | undefined, ctx: { sandboxEnabled: boolean; isAssistantVariant: boolean; staleModeSnapshot: boolean }) {
    const s = { ...state };
    let published: { value: PermissionMode | undefined } | null = null;
    const publishPermissionMode = (mode: PermissionMode | undefined) => { s.permissionMode = mode; published = { value: mode }; };
    const message = { meta };

    let messagePermissionMode: PermissionMode | undefined = s.permissionMode;
    if (ctx.staleModeSnapshot) {
        // keep
    } else if (message.meta?.permissionMode) {
        messagePermissionMode = resolveRemoteClaudePermissionMode(s.permissionMode, message.meta.permissionMode, ctx.sandboxEnabled);
        publishPermissionMode(messagePermissionMode);
    }
    let messageModel = s.model;
    if (message.meta?.hasOwnProperty('model')) { messageModel = message.meta.model || undefined; s.model = messageModel; }
    let messageCustomSystemPrompt = s.customSystemPrompt;
    if (message.meta?.hasOwnProperty('customSystemPrompt')) { messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; s.customSystemPrompt = messageCustomSystemPrompt; }
    let messageFallbackModel = s.fallbackModel;
    if (message.meta?.hasOwnProperty('fallbackModel')) { messageFallbackModel = message.meta.fallbackModel || undefined; s.fallbackModel = messageFallbackModel; }
    let messageAppendSystemPrompt = s.appendSystemPrompt;
    if (message.meta?.hasOwnProperty('appendSystemPrompt')) { messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; s.appendSystemPrompt = messageAppendSystemPrompt; }
    let messageAllowedTools = s.allowedTools;
    if (message.meta?.hasOwnProperty('allowedTools')) { messageAllowedTools = message.meta.allowedTools || undefined; s.allowedTools = messageAllowedTools; }
    let messageDisallowedTools = s.disallowedTools;
    if (message.meta?.hasOwnProperty('disallowedTools')) {
        messageDisallowedTools = withAssistantDenylist(message.meta.disallowedTools || undefined, ctx.isAssistantVariant);
        s.disallowedTools = messageDisallowedTools;
    }
    let messageEffort = s.effort;
    const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    if (message.meta?.hasOwnProperty('effort')) {
        const incoming = (message.meta as Record<string, unknown>).effort;
        if (incoming === null || incoming === undefined) { messageEffort = undefined; s.effort = undefined; }
        else if (typeof incoming === 'string' && VALID_EFFORTS.has(incoming)) { messageEffort = incoming as ClaudeEffort; s.effort = messageEffort; }
    }
    const enhancedMode: EnhancedMode = {
        permissionMode: messagePermissionMode || 'default',
        model: messageModel,
        fallbackModel: messageFallbackModel,
        customSystemPrompt: messageCustomSystemPrompt,
        appendSystemPrompt: messageAppendSystemPrompt,
        allowedTools: messageAllowedTools,
        disallowedTools: messageDisallowedTools,
        effort: messageEffort,
    };
    return { mode: enhancedMode, next: s, published: published as { value: PermissionMode | undefined } | null };
}

const states: ClaudeModeState[] = [
    { permissionMode: undefined },
    { permissionMode: 'default' },
    { permissionMode: 'bypassPermissions', model: 'opus', effort: 'high' },
    { permissionMode: 'yolo', appendSystemPrompt: 'old web prompt', customSystemPrompt: 'custom' },
    { permissionMode: 'plan', allowedTools: ['Read'], disallowedTools: ['Bash'], fallbackModel: 'sonnet' },
];

const metas: Array<MessageMeta | undefined> = [
    undefined,
    {},
    { sentFrom: 'web' },
    { permissionMode: 'default' },
    { permissionMode: 'bypassPermissions' },
    { permissionMode: 'plan' },
    { permissionMode: 'safe-yolo' },
    { model: 'sonnet' },
    { model: null },
    { model: '' },
    { appendSystemPrompt: 'web prompt' },
    { appendSystemPrompt: null },
    { customSystemPrompt: 'c2', fallbackModel: 'haiku' },
    { customSystemPrompt: null, fallbackModel: null },
    { allowedTools: ['Edit'], disallowedTools: ['Write'] },
    { allowedTools: null, disallowedTools: null },
    { effort: 'max' },
    { effort: null },
    { effort: 'bogus' },
    // The web's real first message shape.
    { sentFrom: 'web', appendSystemPrompt: 'web prompt', permissionMode: 'default', model: null, effort: null },
    { sentFrom: 'web', appendSystemPrompt: 'web prompt', permissionMode: 'bypassPermissions', model: 'opus', effort: 'low' },
];

describe('resolveMessageMode (B-515) — parity with the pre-extraction runClaude logic', () => {
    for (const sandboxEnabled of [false, true]) {
        for (const isAssistantVariant of [false, true]) {
            for (const staleModeSnapshot of [false, true]) {
                it(`matches the legacy resolver (sandbox=${sandboxEnabled} assistant=${isAssistantVariant} stale=${staleModeSnapshot})`, () => {
                    const ctx = { sandboxEnabled, isAssistantVariant, staleModeSnapshot };
                    for (const state of states) {
                        for (const meta of metas) {
                            const legacy = legacyResolve(state, meta, ctx);
                            const next = resolveMessageMode(state, meta, ctx);
                            const label = JSON.stringify({ state, meta });
                            expect(next.mode, label).toEqual(legacy.mode);
                            expect(next.next, label).toEqual(legacy.next);
                            expect('publishPermissionMode' in next, label).toBe(legacy.published !== null);
                            if (legacy.published) expect(next.publishPermissionMode, label).toBe(legacy.published.value);
                        }
                    }
                });
            }
        }
    }
});

describe('resolveMessageMode (B-515) — golden cases', () => {
    const ctx = { sandboxEnabled: false, isAssistantVariant: false, staleModeSnapshot: false };

    it('a fresh session + the web first message', () => {
        const r = resolveMessageMode({ permissionMode: 'default' }, {
            sentFrom: 'web', appendSystemPrompt: 'WEB', permissionMode: 'default', model: null, effort: null,
        }, ctx);
        expect(r.mode).toEqual({
            permissionMode: 'default', model: undefined, fallbackModel: undefined, customSystemPrompt: undefined,
            appendSystemPrompt: 'WEB', allowedTools: undefined, disallowedTools: undefined, effort: undefined,
        });
        expect(r.publishPermissionMode).toBe('default');
        expect(r.next.appendSystemPrompt).toBe('WEB');
    });

    it('never downgrades bypass to default from a message snapshot', () => {
        const r = resolveMessageMode({ permissionMode: 'bypassPermissions' }, { permissionMode: 'default' }, ctx);
        expect(r.mode.permissionMode).toBe('bypassPermissions');
    });

    it('a stale snapshot keeps the current mode and publishes nothing', () => {
        const r = resolveMessageMode({ permissionMode: 'acceptEdits' }, { permissionMode: 'plan' }, { ...ctx, staleModeSnapshot: true });
        expect(r.mode.permissionMode).toBe('acceptEdits');
        expect('publishPermissionMode' in r).toBe(false);
    });

    it('keeps sticky fields when the meta omits them, and does not mutate its input', () => {
        const state: ClaudeModeState = { permissionMode: 'default', model: 'opus', effort: 'high', appendSystemPrompt: 'A' };
        const r = resolveMessageMode(state, { sentFrom: 'web' }, ctx);
        expect(r.mode).toMatchObject({ model: 'opus', effort: 'high', appendSystemPrompt: 'A' });
        expect(state).toEqual({ permissionMode: 'default', model: 'opus', effort: 'high', appendSystemPrompt: 'A' });
    });

    it('ignores an unknown effort (reported), keeps the current one', () => {
        const r = resolveMessageMode({ permissionMode: 'default', effort: 'low' }, { effort: 'ultra' }, ctx);
        expect(r.mode.effort).toBe('low');
        expect(r.ignoredEffort).toBe('ultra');
    });

    it('keeps the assistant dispatcher denylist through a per-message override', () => {
        const r = resolveMessageMode({ permissionMode: 'default' }, { disallowedTools: ['X'] }, { ...ctx, isAssistantVariant: true });
        expect(r.mode.disallowedTools).toEqual(withAssistantDenylist(['X'], true));
    });
});
