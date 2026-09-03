import { describe, expect, it } from 'vitest';
import { withTimeout } from './staleBundleReload';

describe('withTimeout', () => {
    // The freeze this fixes: registration.update() fetches over the network and
    // was awaited without a bound, so a hung fetch meant the reload never ran
    // and the button sat on "Refreshing…" forever.
    it('gives up on work that never settles', async () => {
        const started = Date.now();
        await withTimeout(new Promise(() => {}), 20);
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('returns as soon as the work finishes', async () => {
        const started = Date.now();
        await withTimeout(Promise.resolve('done'), 5000);
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('never rejects, so a failing step cannot block the reload', async () => {
        await expect(withTimeout(Promise.reject(new Error('nope')), 5000)).resolves.toBeUndefined();
    });
});
