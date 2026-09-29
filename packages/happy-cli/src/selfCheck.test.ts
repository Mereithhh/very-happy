import { describe, expect, it } from 'vitest';
import { runSelfCheck } from './selfCheck';
import { isSelfCheckRequest, isStandaloneVersionRequest } from './utils/versionArgs';

describe('self-check (B-512)', () => {
    it('reports each module that fails to load, and keeps going', async () => {
        const loaded: string[] = [];
        const failures = await runSelfCheck([
            ['ok-1', async () => { loaded.push('ok-1'); }],
            ['broken', async () => { throw new Error('Cannot find module x'); }],
            ['ok-2', async () => { loaded.push('ok-2'); }],
        ]);
        expect(loaded).toEqual(['ok-1', 'ok-2']);
        expect(failures).toEqual([{ name: 'broken', error: 'Cannot find module x' }]);
    });

    it('is only triggered by the bare flag', () => {
        expect(isSelfCheckRequest(['--self-check'])).toBe(true);
        expect(isSelfCheckRequest(['--self-check', 'x'])).toBe(false);
        expect(isSelfCheckRequest(['claude', '--self-check'])).toBe(false);
        expect(isStandaloneVersionRequest(['--self-check'])).toBe(false);
    });
});
