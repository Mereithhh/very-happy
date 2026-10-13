/**
 * B-567 review #3: runs the REAL public/push-sw.js notificationclick in a fake
 * worker scope (node:vm). The tap is a human gesture the page can't see, so
 * the SW hands it over as a one-shot `vh_presence=1` URL marker
 * (consumed by src/app/presenceBoot.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../../../public/push-sw.js', import.meta.url)), 'utf8');

function click(url: string | undefined, existingWindow: boolean) {
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const calls: { navigate: string[]; open: string[] } = { navigate: [], open: [] };
    const win = { focus: async () => {}, navigate: async (u: string) => { calls.navigate.push(u); } };
    const scope: Record<string, unknown> = {
        addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
        location: new URL('https://veryhappy.dev/sw.js'),
        clients: {
            matchAll: async () => (existingWindow ? [win] : []),
            openWindow: async (u: string) => { calls.open.push(u); },
        },
        registration: { showNotification: async () => {} },
        URL, Response, JSON, Number, Math, Promise, String, Date,
    };
    scope.self = scope;
    vm.runInNewContext(SRC, scope);
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners.notificationclick ?? []) {
        fn({ notification: { close: () => {}, data: url === undefined ? undefined : { url } }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    }
    return Promise.all(waits).then(() => calls);
}

describe('push-sw.js notificationclick presence marker', () => {
    it('cold open: openWindow gets the marked URL', async () => {
        expect((await click('/session/abc', false)).open).toEqual(['/session/abc?vh_presence=1']);
    });
    it('existing window: navigate keeps the terminal query and hash', async () => {
        expect((await click('/terminal/m1?tid=t9#x', true)).navigate).toEqual(['/terminal/m1?tid=t9&vh_presence=1#x']);
    });
    it('no url → app root, still marked', async () => {
        expect((await click(undefined, false)).open).toEqual(['/?vh_presence=1']);
    });
    it('a foreign-origin url is passed through untouched', async () => {
        expect((await click('https://example.com/x', false)).open).toEqual(['https://example.com/x']);
    });
});
