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
});
