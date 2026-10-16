/**
 * B-614 — CDS surface ladder + 1-Border Rule (docs/design-language.md §2.1).
 *
 * Owner: 「方框卡片里面包着一层卡片，我觉得这个是非常怪的。」 These assertions pin
 * the two halves of the fix: the token ladder that gives depth WITHOUT boxing
 * everything (sidebar below the canvas, code wells below the canvas, cards and
 * composer above it), and the source rules that keep exactly one closed outline
 * per object (tool output / code / table / composer / permission card) with the
 * inside borderless. The rendered check is scripts/dev/nesting-audit.mjs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const tokens = read('./tokens.css');

function block(selectorStart: string): Record<string, string> {
    const start = tokens.indexOf(selectorStart);
    expect(start, selectorStart).toBeGreaterThan(-1);
    const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
    return out;
}
function luminance(hex: string): number {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(fg: string, bg: string): number {
    const [a, b] = [luminance(fg), luminance(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const lum = luminance;

/** First rule body for an exact selector. */
function rule(source: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `missing CSS rule ${selector}`).not.toBeNull();
    return match?.[1] ?? '';
}

describe.each([
    ['dark', ":root,\n:root[data-theme='dark']"],
    ['light', ":root[data-theme='light']"],
])('%s CDS surface ladder', (_theme, selector) => {
    const t = block(selector);
    it('puts the sidebar and the code well BELOW the canvas, cards and composer at or above it', () => {
        expect(lum(t['--surface-sidebar'])).toBeLessThan(lum(t['--bg-0']));
        expect(lum(t['--surface-code'])).toBeLessThan(lum(t['--bg-0']));
        expect(lum(t['--bg-1'])).toBeGreaterThanOrEqual(lum(t['--bg-0']));
        expect(lum(t['--surface-raised'])).toBeGreaterThanOrEqual(lum(t['--bg-1']));
    });
    it('keeps every text step AA (≥4.5:1) on the canvas, cards, fills, sidebar and code well', () => {
        for (const surface of ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--surface-sidebar', '--surface-code', '--surface-raised']) {
            for (const ink of ['--text', '--text-dim', '--text-faint']) {
                const ratio = contrast(t[ink], t[surface]);
                expect(ratio, `${ink} on ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });
});

describe('1-Border Rule in source (B-614)', () => {
    const toolgroup = read('../screens/session/toolgroup.css');
    it('never wraps a tool group or a tool row in a card', () => {
        expect(toolgroup).not.toContain('.tg-stack');
        expect(rule(toolgroup, '.tg-row')).not.toMatch(/border:|box-shadow/);
        expect(rule(toolgroup, '.tg')).not.toMatch(/border:|box-shadow/);
    });
    it.each([
        ['tool output', '../screens/session/command.css', '.cmd', 'var(--panel-shadow)'],
        ['code block', '../screens/session/code.css', '.cv', 'var(--panel-shadow)'],
        ['table', '../screens/session/markdown.css', '.md-table-wrap', 'var(--panel-shadow)'],
        ['composer', '../screens/session/input.css', '.ci-composer', 'var(--shadow-composer)'],
    ])('the %s is the one closed object: a shadow ring, no solid border', (_name, file, selector, shadow) => {
        const body = rule(read(file), selector);
        expect(body).toContain(`box-shadow: ${shadow}`);
        expect(body).not.toMatch(/border:\s*1px solid var\(--line/);
    });
    it('keeps the inside of the permission card borderless', () => {
        const permission = read('../screens/session/permission.css');
        expect(rule(permission, '.perm-card .cv')).toContain('box-shadow: none');
        expect(rule(permission, '.perm-card')).toContain('border: 0');
    });
    it('makes secondary and danger buttons fill-only (no ring inside containers)', () => {
        const ui = read('../ui/ui.css');
        expect(rule(ui, '.vh-btn--secondary')).not.toMatch(/border-color/);
        expect(rule(ui, '.vh-btn--danger')).not.toMatch(/border-color/);
    });
});
