import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routedSessionId } from './routedSession';

describe('B-819 routedSessionId', () => {
    it('the app route /session/:id only', () => {
        expect(routedSessionId('/session/cmabc123')).toBe('cmabc123');
        expect(routedSessionId('/session/cmabc123/')).toBe('cmabc123');
        expect(routedSessionId('/session/a%20b')).toBe('a b');
        expect(routedSessionId('/')).toBeNull();
        expect(routedSessionId('/session/')).toBeNull();
        expect(routedSessionId('/session/x/files')).toBeNull();
        expect(routedSessionId('/dev/device/session/x')).toBeNull();
        expect(routedSessionId('/session/%E0%A4%A')).toBeNull();
        expect(routedSessionId(undefined)).toBeNull();
    });
});

describe('B-819 wiring: #init starts the routed session\'s catch-up with the session list', () => {
    it('right after the message cache opens, from location.pathname', () => {
        const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
        const init = source.slice(source.indexOf('async #init()'));
        expect(init).toMatch(/void syncCache\.open\(this\.serverID\);\s*\/\/[^\n]*\n\s*this\.startRoutedCatchUp\(globalThis\.location\?\.pathname\);/);
        // …before the session list is asked for.
        expect(init.indexOf('this.startRoutedCatchUp(')).toBeLessThan(init.indexOf('this.sessionsSync.invalidate()'));
    });
});
