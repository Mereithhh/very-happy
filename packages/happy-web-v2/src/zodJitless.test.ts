import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('zod jitless (B-825)', () => {
    it('is the first import of the entry, so no schema is built with the JIT probe', () => {
        const main = readFileSync(join(__dirname, 'main.tsx'), 'utf8');
        const firstImport = main.split('\n').find((line) => line.startsWith('import '));
        expect(firstImport).toBe("import './zodJitless';");
    });

    it('turns the JIT (and its `new Function` probe) off', async () => {
        await import('./zodJitless');
        expect(z.config().jitless).toBe(true);
    });
});
