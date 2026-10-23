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
});
