import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

function session(partial: {
    permissionMode?: string | null;
    modelMode?: string | null;
    effortLevel?: string | null;
    flavor?: string;
}) {
    return {
        permissionMode: partial.permissionMode ?? null,
        modelMode: partial.modelMode ?? null,
        effortLevel: partial.effortLevel ?? null,
        metadata: partial.flavor ? ({ flavor: partial.flavor } as any) : null,
    } as any;
}

describe('resolveMessageModeMeta (B-103)', () => {
    it('claude fresh session sends EXPLICIT null model/effort (machine-default reset)', () => {
        const meta = resolveMessageModeMeta(session({}));
        // null (present) — not omitted: the CLI decodes null → undefined → SDK
        // runs the machine's own /model + adaptive thinking; an omitted field
        // would leave the CLI's sticky state in force.
        expect(meta.model).toBeNull();
        expect(meta.effort).toBeNull();
        expect('model' in meta).toBe(true);
        expect('effort' in meta).toBe(true);
    });

    it("explicit 'default' model still maps to null; picked values pass through", () => {
        expect(resolveMessageModeMeta(session({ modelMode: 'default' })).model).toBeNull();
        expect(resolveMessageModeMeta(session({ modelMode: 'fable' })).model).toBe('fable');
        expect(resolveMessageModeMeta(session({ effortLevel: 'high' })).effort).toBe('high');
    });

    it('settings override wins over the implicit default', () => {
        const meta = resolveMessageModeMeta(session({}), {
            agentDefaultOverrides: { claude: { effortLevel: 'low', modelMode: 'sonnet' } },
        } as any);
        expect(meta.effort).toBe('low');
        expect(meta.model).toBe('sonnet');
    });

    it('non-claude flavors keep omit-when-unset semantics (their runners are not audited for null)', () => {
        const meta = resolveMessageModeMeta(session({ flavor: 'gemini' }));
        expect('model' in meta).toBe(false);
        expect('effort' in meta).toBe(false);
    });

    it('permissionMode passes through when set, omitted when null', () => {
        expect(resolveMessageModeMeta(session({ permissionMode: 'plan' })).permissionMode).toBe('plan');
        expect('permissionMode' in resolveMessageModeMeta(session({}))).toBe(false);
    });

    it('B-262 A2: falls back to the synced override only — never to the code default (yolo)', () => {
        const overrides = (mode?: string) => ({ agentDefaultOverrides: mode ? { claude: { permissionMode: mode } } : {} });
        expect(resolveMessageModeMeta(session({}), overrides('bypassPermissions')).permissionMode).toBe('bypassPermissions');
        // override=plan is a downgrade guess for a session with no local value: omitted (today it would be sent)
        expect('permissionMode' in resolveMessageModeMeta(session({}), overrides('plan'))).toBe(false);
        expect('permissionMode' in resolveMessageModeMeta(session({}), overrides('dontAsk'))).toBe(false);
        expect('permissionMode' in resolveMessageModeMeta(session({}), overrides())).toBe(false);
        // local wins over override, symmetrically
        expect(resolveMessageModeMeta(session({ permissionMode: 'plan' }), overrides('bypassPermissions')).permissionMode).toBe('plan');
        // non-claude vocab untouched
        expect(resolveMessageModeMeta(session({ flavor: 'codex' }), { agentDefaultOverrides: { codex: { permissionMode: 'read-only' } } }).permissionMode).toBe('read-only');
    });

    it('B-262 A1: a dead selector key never reaches the CLI (it would drop the whole message)', () => {
        expect(resolveMessageModeMeta(session({ permissionMode: 'dontAsk' })).permissionMode).toBe('default');
        expect(resolveMessageModeMeta(session({ permissionMode: 'yolo' })).permissionMode).toBe('bypassPermissions');
    });
});
