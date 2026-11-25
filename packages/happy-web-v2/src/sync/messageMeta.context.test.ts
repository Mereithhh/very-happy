import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

const codexSession = (metadata: Record<string, unknown>, contextMode?: string | null) => ({
    id: 's1',
    permissionMode: 'yolo',
    modelMode: null,
    effortLevel: null,
    contextMode: contextMode ?? null,
    metadata: {
        flavor: 'codex',
        capabilities: ['codex-context-mode-v1'],
        currentModelCode: 'gpt-6.2-astra',
        codexContextMode: 'standard',
        codexContextWindows: { 'gpt-6.2-astra': { standard: 258400, extended: 828400 } },
        models: [{ code: 'gpt-6.2-astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        ...metadata,
    },
}) as unknown as Parameters<typeof resolveMessageModeMeta>[0];

describe('B-977 meta.codexContext', () => {
    it('sends the mode a session with an extendable model runs', () => {
        expect(resolveMessageModeMeta(codexSession({})).codexContext).toBe('standard');
        expect(resolveMessageModeMeta(codexSession({ codexContextMode: 'extended' })).codexContext).toBe('extended');
        expect(resolveMessageModeMeta(codexSession({ codexContextMode: undefined }, 'extended')).codexContext).toBe('extended');
    });

    it('sends nothing for a model with one window, an older wrapper, or another agent', () => {
        expect(resolveMessageModeMeta(codexSession({ currentModelCode: 'gpt-5.5' })).codexContext).toBeUndefined();
        expect(resolveMessageModeMeta(codexSession({ codexContextWindows: undefined, codexContextMode: undefined }, 'extended')).codexContext).toBeUndefined();
        expect(resolveMessageModeMeta({ ...codexSession({}), metadata: { ...codexSession({}).metadata, flavor: 'claude' } } as unknown as Parameters<typeof resolveMessageModeMeta>[0]).codexContext).toBeUndefined();
    });

    it('the account default applies when the session has no report', () => {
        const session = { ...codexSession({ codexContextMode: undefined }), modelMode: 'gpt-6.2-astra' };
        expect(resolveMessageModeMeta(session, { agentDefaultOverrides: { codex: { contextMode: 'extended' } } }).codexContext).toBe('extended');
    });
});
