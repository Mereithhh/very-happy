import { describe, expect, it } from 'vitest';
import { smokeConfig, smokeMarker, terminalShowsOutput } from './smokeLib.mjs';

describe('B-024 smoke configuration', () => {
    it('skips (does not fail) without CI credentials, and defaults to production', () => {
        expect(smokeConfig({}).skipReason).toMatch(/VH_SMOKE_USERNAME/);
        expect(smokeConfig({ VH_SMOKE_USERNAME: 'u' }).skipReason).toMatch(/VH_SMOKE_PASSWORD/);
        const c = smokeConfig({ VH_SMOKE_USERNAME: ' smoke ', VH_SMOKE_PASSWORD: 'p' });
        expect(c).toMatchObject({ url: 'https://veryhappy.dev', username: 'smoke', machine: null, skipReason: null });
    });

    it('accepts a staging URL and a machine name, rejects a non-http URL', () => {
        expect(smokeConfig({ VH_SMOKE_USERNAME: 'u', VH_SMOKE_PASSWORD: 'p', VH_SMOKE_URL: 'http://127.0.0.1:5321/', VH_SMOKE_MACHINE: 'dev-sg' }))
            .toMatchObject({ url: 'http://127.0.0.1:5321', machine: 'dev-sg', skipReason: null });
        expect(smokeConfig({ VH_SMOKE_USERNAME: 'u', VH_SMOKE_PASSWORD: 'p', VH_SMOKE_URL: 'ftp://x' }).skipReason).toMatch(/not an http/);
    });
});

describe('B-024 terminal echo assertion', () => {
    it('the expected text appears only in the command OUTPUT, never in the typed keystrokes', () => {
        const m = smokeMarker('a1-b2');
        expect(m.command).toBe('echo VH_SMOKE_$((40+2))_a1b2');
        expect(m.command.includes(m.expected)).toBe(false);
        expect(terminalShowsOutput(`$ ${m.command}`, m)).toBe(false);
        expect(terminalShowsOutput(`$ ${m.command}\n${m.expected}\n$`, m)).toBe(true);
    });
});
