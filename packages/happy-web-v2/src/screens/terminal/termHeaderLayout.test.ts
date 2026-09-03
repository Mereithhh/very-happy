import { describe, expect, it } from 'vitest';
import { planTermHeaderActions } from './termHeaderLayout';

const input = (patch: Partial<Parameters<typeof planTermHeaderActions>[0]> = {}) => ({
    compact: true,
    hasMirror: true,
    showSelect: true,
    showPresets: false,
    hasTmuxSession: true,
    ...patch,
});

describe('planTermHeaderActions', () => {
    it('keeps the structured-view toggle on the bar on the narrowest phone (B-105)', () => {
        const plan = planTermHeaderActions(input());
        expect(plan.inline).toEqual(['structured']);
        expect(plan.overflow).not.toContain('structured');
    });

    it('leaves exactly one collapsible trigger worth of chrome on compact', () => {
        // The regression this prevents: 6 rigid 30px buttons + gaps (~220px)
        // next to a 32px back button and a status chip on a 360-390px viewport.
        expect(planTermHeaderActions(input()).inline.length).toBeLessThanOrEqual(1);
    });

    it('collapses every secondary control, in a stable order', () => {
        expect(planTermHeaderActions(input()).overflow).toEqual(['notes', 'select', 'files', 'refit', 'tmuxHelp']);
    });

    it('does not collapse anything on a roomy viewport', () => {
        const plan = planTermHeaderActions(input({ compact: false }));
        expect(plan.overflow).toEqual([]);
        expect(plan.inline).toEqual(['structured', 'notes', 'select', 'files', 'refit', 'tmuxHelp']);
    });

    it('offers select-mode and the presets picker independently, as their own gates decide', () => {
        // A narrow DESKTOP window has both: single-pane (select) and a fine
        // pointer (presets). A phone has only select; a wide desktop only presets.
        const both = planTermHeaderActions(input({ compact: false, showSelect: true, showPresets: true }));
        expect(both.inline).toEqual(['structured', 'notes', 'select', 'presets', 'files', 'refit', 'tmuxHelp']);
        expect(planTermHeaderActions(input({ compact: false, showSelect: false, showPresets: true })).inline).not.toContain('select');
        expect(planTermHeaderActions(input({ compact: false, showSelect: true, showPresets: false })).inline).not.toContain('presets');
    });

    it('keeps the presets picker on the bar even when compact — it is a panel, not a menu item', () => {
        const plan = planTermHeaderActions(input({ showSelect: true, showPresets: true }));
        expect(plan.inline).toEqual(['structured', 'presets']);
        expect(plan.overflow).toEqual(['notes', 'select', 'files', 'refit', 'tmuxHelp']);
    });

    it('omits controls whose feature is absent, rather than showing a dead button', () => {
        const plan = planTermHeaderActions(input({ hasMirror: false, hasTmuxSession: false }));
        expect(plan.inline).toEqual([]);
        expect(plan.overflow).toEqual(['notes', 'select', 'files', 'refit']);
    });

    it('leaves no trigger at all when nothing collapsible exists', () => {
        // (not reachable today — notes/files/refit are unconditional — but the
        // caller renders the "⋯" only when overflow is non-empty)
        expect(planTermHeaderActions(input({ compact: false })).overflow).toHaveLength(0);
    });
});
