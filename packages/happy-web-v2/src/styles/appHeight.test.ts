import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// iOS 26 home-screen apps report 100dvh/100% short by the top safe-area
// inset; the full-screen shells must size against --app-h (100lvh there).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const base = read('./base.css');
const shells: Record<string, string> = {
    'screens/layout.css': read('../screens/layout.css'),
    'screens/assistant/assistant.css': read('../screens/assistant/assistant.css'),
    'screens/auth/auth.css': read('../screens/auth/auth.css'),
    'screens/auth/terminalConnect.css': read('../screens/auth/terminalConnect.css'),
    'app/RouteLoading.tsx': read('../app/RouteLoading.tsx'),
    'app/ChunkFailure.tsx': read('../app/ChunkFailure.tsx'),
};

describe('full-screen shell height (iOS 26 standalone bottom gap)', () => {
    it('--app-h is 100dvh by default and 100lvh only in standalone WebKit', () => {
        expect(base).toMatch(/:root \{\s*--app-h: 100dvh;/);
        expect(base).toMatch(/@media \(display-mode: standalone\) \{\s*@supports \(-webkit-touch-callout: none\) \{\s*:root \{\s*--app-h: 100lvh;/);
        expect(base).toMatch(/html \{\s*height: var\(--app-h\);/);
        expect(base).toContain('min-height: var(--app-h);');
    });

    it.each(Object.keys(shells))('%s uses --app-h, not a bare 100dvh', (file) => {
        expect(shells[file]).toContain('var(--app-h)');
        expect(shells[file]).not.toMatch(/(?<![-\w])(min-)?height:\s*'?100dvh/);
        expect(shells[file]).not.toMatch(/[hH]eight: (fullViewport \? )?'100dvh'/);
    });

    it('session composer clears the home indicator except while the keyboard is pinned', () => {
        const session = read('../screens/session/session.css');
        expect(session).toMatch(/\.sd-foot \{\s*padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
        expect(session).toMatch(/\.sd\[data-keyboard-open='true'\] \.sd-foot \{\s*padding-bottom: 0;/);
    });
});
