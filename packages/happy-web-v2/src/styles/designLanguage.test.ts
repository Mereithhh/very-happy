import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function css(relativePath: string): string {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function rule(source: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `missing CSS rule ${selector}`).not.toBeNull();
    return match?.[1] ?? '';
}

describe('app visual language', () => {
    it('keeps the documented neutral palette and a separate terminal palette', () => {
        const tokens = css('./tokens.css');
        expect(tokens).toContain('--bg-0: #111210');
        expect(tokens).toContain('--bg-0: #f4f4f1');
        expect(tokens).toContain('--accent: #56b8a7');
        expect(tokens).toContain('--accent: #167d70');
        expect(tokens).toContain('--term-bg: #06080c');
        expect(tokens).toContain('docs/design-language.md');
    });

    it.each([
        ['sub-agent type badge', css('../screens/session/toolview.css'), '.tv-badge'],
        ['sub-agent process line', css('../screens/session/toolgroup.css'), '.tg-subagent-line'],
        ['turn sub-agent chip', css('../screens/session/turnactivity.css'), '.ta-subagents'],
    ])('%s stays neutral — accent is reserved for live states', (_name, source, selector) => {
        const declarations = rule(source, selector);
        expect(declarations).not.toContain('var(--accent');
    });

    it.each([
        ['permission-mode confirmation note', css('../screens/session/modemenu.css'), '.mm-sub'],
        ['session options field hint', css('../screens/session/sessionOptionsDialog.css'), '.so-field-hint'],
    ])('%s stays neutral — accent is reserved for live states', (_name, source, selector) => {
        const declarations = rule(source, selector);
        expect(declarations).not.toContain('var(--accent');
    });

    it.each([
        ['legacy primary button', css('../App.css'), '.btn-primary'],
        ['design-system primary button', css('../ui/ui.css'), '.vh-btn--primary'],
        ['modal primary button', css('../modal/modal.css'), '.vh-modal-btn.is-primary'],
        ['chat send button', css('../screens/session/input.css'), '.ci-send'],
    ])('%s uses ink instead of the live accent', (_name, source, selector) => {
        const declarations = rule(source, selector);
        expect(declarations).toContain('background: var(--text)');
        expect(declarations).toContain('color: var(--bg-0)');
        expect(declarations).not.toContain('var(--accent)');
    });
});
