import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uses conventional Maple symbols in the terminal, including plain @ (B-392)', () => {
    const css = readFileSync(new URL('./terminal.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/\.term-host\s+\.xterm\s*\{([^}]+)\}/)?.[1];
    expect(rule).toMatch(/font-feature-settings:\s*"cv01"\s+1\s*;/);
});
