import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sync log privacy', () => {
    it('does not serialize decrypted settings or profile PII to diagnostics', () => {
        const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/console\.log\(['"]settings['"],\s*JSON\.stringify/);
        expect(source).not.toMatch(/console\.log\(['"]profile['"],\s*JSON\.stringify/);
        expect(source).not.toMatch(/JSON\.stringify\(\{[\s\S]{0,120}settings:\s*parsedSettings/);
        expect(source).not.toMatch(/firstName:\s*parsedProfile\.firstName/);
        expect(source).not.toMatch(/lastName:\s*parsedProfile\.lastName/);
    });
});
