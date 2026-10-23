/**
 * B-796: the iPhone Duo cover display puts its status column on the RIGHT edge
 * in portrait (inset right ≈ 84pt), and production only padded top/bottom — the
 * header ＋ and 「按项目」 sat under the clock. Guards: every stylesheet reads
 * the insets through the `--sa-*` mirrors (so device-shots can simulate a side
 * inset), and the app shell + phone sheets pad the left/right insets.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function cssFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith('.css') ? [path] : [];
    });
}

type Rule = { file: string; selectors: string[]; body: string };

function cssRules(): Rule[] {
    return cssFiles(SRC).flatMap((path) => {
        const file = relative(SRC, path);
        const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({ file, selectors: m[1].split(',').map((x) => x.trim()), body: m[2] }));
    });
}

const flush = (value: string) => /^(0|0px|auto)$/.test(value.replace(/!important/, '').trim());

/**
 * Side-edge declarations that ignore the inset on their side: `left` must read
 * `--sa-l`, `right` `--sa-r`; a centred box (`50%`), a horizontal `inset` and a
 * `calc(100vw - …)` width need both. Flush edges (`0`, `auto`) are full-bleed boxes
 * that pad the inset instead.
 */
function sideMisses(body: string): string[] {
    const out: string[] = [];
    const needs = (decl: string, value: string, sides: string[]) => {
        if (sides.some((side) => !value.includes(`var(--sa-${side})`))) out.push(decl);
    };
    for (const [, prop, raw] of body.matchAll(/(?:^|[;\s])(left|right|inset|width|max-width)\s*:\s*([^;]+)/g)) {
        const value = raw.replace(/!important/, '').trim();
        const decl = `${prop}: ${value}`;
        if (prop === 'width' || prop === 'max-width') { if (value.includes('calc(100vw')) needs(decl, value, ['l', 'r']); continue; }
        if (prop === 'inset') {
            const parts = value.split(/\s+(?![^(]*\))/);
            const sides = parts.length === 1 ? [parts[0]] : parts.length < 4 ? [parts[1]] : [parts[1], parts[3]];
            if (sides.some((v) => !flush(v))) needs(decl, value, ['l', 'r']);
            continue;
        }
        if (flush(value)) continue;
        needs(decl, value, value.includes('50%') ? ['l', 'r'] : [prop === 'left' ? 'l' : 'r']);
    }
    return out;
}

/** Selectors (any rule) that make a box `position: fixed`. */
const fixedSelectors = (rules: Rule[]) => new Set(rules.filter((r) => /position:\s*fixed/.test(r.body)).flatMap((r) => r.selectors));
/** The same element: the fixed selector itself or it narrowed by attribute / class / state (`.wn-card[data-featured]`). */
const isFixed = (fixed: Set<string>, selector: string) =>
    [...fixed].some((f) => selector === f || (selector.startsWith(f) && /^([[.]|:(?!:))/.test(selector.slice(f.length)) && !/[\s>+~]/.test(selector.slice(f.length))));

describe('four-sided safe area', () => {
    it('defines one mirror per side from env()', () => {
        const base = read('styles/base.css');
        for (const [v, side] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) {
            expect(base).toContain(`--sa-${v}: env(safe-area-inset-${side}, 0px);`);
        }
    });

    it('no stylesheet reads env(safe-area-inset-*) directly', () => {
        // base.css defines the mirrors; the diag page paints the raw system values on purpose.
        const allowed = new Set(['styles/base.css', 'diag/safeAreaDiag.css']);
        const offenders = cssFiles(SRC)
            .map((path) => relative(SRC, path))
            .filter((rel) => !allowed.has(rel) && /env\(safe-area-inset-/.test(read(rel)));
        expect(offenders).toEqual([]);
    });

    it('the app shell keeps every in-shell page clear of the side insets', () => {
        const shell = /\.app-shell \{[^}]*\}/.exec(read('screens/layout.css'))?.[0] ?? '';
        expect(shell).toContain('padding-right: var(--sa-r);');
        expect(shell).toContain('padding-left: var(--sa-l);');
    });

    it('the phone bottom sheet and its sticky footer pad the side insets', () => {
        const dialog = read('styles/dialog.css');
        expect(dialog).toContain('padding: var(--sp-4) calc(var(--sp-4) + var(--sa-r)) 0 calc(var(--sp-4) + var(--sa-l));');
        expect(dialog).toContain('padding: var(--sp-3) calc(var(--sp-4) + var(--sa-r)) max(var(--sp-3), var(--sa-b)) calc(var(--sp-4) + var(--sa-l));');
    });

    it('toasts centre between the side insets', () => {
        expect(read('ui/ui.css')).toContain('left: calc(50% + (var(--sa-l) - var(--sa-r)) / 2);');
    });

    it('every fixed box offset from a side edge reads that side inset', () => {
        // dev/ and diag/ are not shipped screens; the landing grid bleeds past the viewport on purpose.
        const exempt = (r: Rule) => /^(dev|diag)\//.test(r.file) || r.selectors.includes('.pub-page::after');
        const rules = cssRules();
        const fixed = fixedSelectors(rules);
        const offenders = rules
            .filter((r) => !exempt(r) && r.selectors.some((x) => isFixed(fixed, x)))
            .filter((r) => sideMisses(r.body).length > 0)
            .map((r) => `${r.file} ${r.selectors.join(', ')} → ${sideMisses(r.body).join('; ')}`);
        expect(offenders).toEqual([]);
    });

    it('a ✕ on an edge-to-edge fixed sheet clears the side insets', () => {
        const rules = cssRules();
        const fixed = fixedSelectors(rules);
        const edgeToEdge = (body: string) => /(?:^|[;\s])(?:left|right)\s*:\s*0(?:px)?\s*(?:;|$)|width:\s*100(?:%|vw)/.test(body);
        const offenders: string[] = [];
        for (const file of new Set(rules.map((r) => r.file))) {
            const inFile = rules.filter((r) => r.file === file);
            const sheets = inFile.filter((r) => r.selectors.some((x) => isFixed(fixed, x)) && edgeToEdge(r.body));
            if (sheets.length === 0) continue;
            const closers = new Set(inFile.filter((r) => /position:\s*absolute/.test(r.body)).flatMap((r) => r.selectors).filter((x) => /close\b|__close|-x$/.test(x)));
            for (const sel of closers) {
                const own = inFile.filter((r) => r.selectors.includes(sel));
                // The phone override is the rule that must read the inset; the desktop card is already clear of it.
                if (!own.some((r) => /right:[^;]*var\(--sa-r\)/.test(r.body))) offenders.push(`${file} ${sel}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the release-notes ✕ clears the right inset on the phone sheet (B-796b)', () => {
        const css = read('app/changelogNotice.css');
        const phone = css.slice(css.indexOf('@media (max-width: 520px)'));
        expect(phone).toContain('.wn-close { right: calc(var(--sp-3) + var(--sa-r)); }');
    });

    it('sideMisses checks each side declaration against its own inset', () => {
        expect(sideMisses('inset: 0; left: auto; right: 0 !important; width: 100%')).toEqual([]);
        expect(sideMisses('right: var(--sp-3); top: 4px')).toEqual(['right: var(--sp-3)']);
        expect(sideMisses('right: max(var(--sp-4), var(--sa-l))')).toHaveLength(1);
        expect(sideMisses('inset: 0 calc(8px + var(--sa-r)) 0 8px')).toHaveLength(1);
        expect(sideMisses('left: calc(50% + var(--sa-l) / 2)')).toHaveLength(1);
        expect(sideMisses('width: min(360px, calc(100vw - 32px - var(--sa-l) - var(--sa-r)))')).toEqual([]);
        expect(sideMisses('width: min(360px, calc(100vw - 32px))')).toHaveLength(1);
    });
});
