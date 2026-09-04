import { describe, expect, it } from 'vitest';
import { safeUrlTransform } from './markdownPlugins';

describe('safeUrlTransform', () => {
    it('allows the schemes we actually render', () => {
        expect(safeUrlTransform('https://example.com/x')).toBe('https://example.com/x');
        expect(safeUrlTransform('http://example.com')).toBe('http://example.com');
        expect(safeUrlTransform('mailto:a@b.c')).toBe('mailto:a@b.c');
    });

    it('allows relative links', () => {
        expect(safeUrlTransform('/docs/a.md')).toBe('/docs/a.md');
        expect(safeUrlTransform('./a.md#x')).toBe('./a.md#x');
        expect(safeUrlTransform('#anchor')).toBe('#anchor');
        // a colon after a path delimiter is not a scheme
        expect(safeUrlTransform('./weird:name')).toBe('./weird:name');
    });

    it('blocks javascript: and data:', () => {
        expect(safeUrlTransform('javascript:alert(1)')).toBe('');
        expect(safeUrlTransform(' JavaScript:alert(1)')).toBe('');
        expect(safeUrlTransform('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
    });

    it('is a WHITELIST, not a blacklist — this case proves the test can fail', () => {
        // react-markdown's defaultUrlTransform lets these through; ours must not.
        // (Without this assertion the javascript:/data: cases above would pass
        // even if safeUrlTransform were deleted entirely.)
        expect(safeUrlTransform('tel:+15551234')).toBe('');
        expect(safeUrlTransform('xmpp:a@b.c')).toBe('');
        expect(safeUrlTransform('intent://x#Intent;end')).toBe('');
    });
});

describe('safeUrlTransform — protocol-relative', () => {
    it('blocks //host (no scheme to check, but it still leaves the site)', () => {
        expect(safeUrlTransform('//evil.example/x')).toBe('');
        expect(safeUrlTransform(' //evil.example')).toBe('');
    });
});
