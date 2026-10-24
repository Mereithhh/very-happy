import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const zIndex = (css: string, selector: string) => {
    const body = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    const z = body.match(/z-index:\s*(\d+)/)?.[1];
    return z === undefined ? 0 : Number(z);
};

// B-798 P1-7: a code-block copy overlay (z 1) scrolled under 「上一条 / 下一条提问」 took the taps.
describe('transcript floating nav layer', () => {
    const overlay = zIndex(read('../../ui/ui.css'), '.vh-copy--overlay');
    it('keeps the prompt nav above in-transcript overlays', () => {
        expect(overlay).toBeGreaterThan(0);
        expect(zIndex(read('./chatReadingAids.css'), '.cl-promptnav')).toBeGreaterThan(overlay);
    });
    it('keeps jump-to-latest above them too', () => {
        expect(zIndex(read('./chatlist.css'), '.cl-jump')).toBeGreaterThan(overlay);
    });
    it('stays above sticky table headers (z 2)', () => {
        expect(zIndex(read('./chatReadingAids.css'), '.cl-promptnav')).toBeGreaterThan(2);
    });
});
