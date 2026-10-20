import { describe, expect, it } from 'vitest';
import { localPathFromHref } from './markdownHref';
import { safeUrlTransform } from './markdownPlugins';

// B-639: what `<Markdown>` sees is the href after safeUrlTransform.
const local = (href: string) => localPathFromHref(safeUrlTransform(href));

describe('localPathFromHref (B-639)', () => {
    it('treats bare, relative and absolute paths as files on the agent machine', () => {
        expect(local('web_v23_2_encoding_spans_20261020.jsonnet')).toBe('web_v23_2_encoding_spans_20261020.jsonnet');
        expect(local('./out/a.jsonnet')).toBe('./out/a.jsonnet');
        expect(local('/Users/me/repo/a.jsonnet')).toBe('/Users/me/repo/a.jsonnet');
        expect(local('~/notes/a.md')).toBe('~/notes/a.md');
    });

    it('drops editor positions and decodes escapes', () => {
        expect(local('src/a.ts#L42')).toBe('src/a.ts');
        expect(local('/repo/src/a.ts:42:7')).toBe('/repo/src/a.ts');
        expect(local('/repo/my%20file.md')).toBe('/repo/my file.md');
    });

    it('accepts file: URLs and Windows drive paths', () => {
        expect(local('file:///Users/me/a.jsonnet')).toBe('/Users/me/a.jsonnet');
        expect(local('file:///C:/work/a.txt')).toBe('C:/work/a.txt');
        expect(local('C:\\work\\a.txt')).toBe('C:\\work\\a.txt');
    });

    it('leaves real links and in-page anchors alone', () => {
        expect(local('https://example.com/a.jsonnet')).toBeNull();
        expect(local('http://example.com')).toBeNull();
        expect(local('mailto:a@b.c')).toBeNull();
        expect(local('#section')).toBeNull();
        expect(local('javascript:alert(1)')).toBeNull();
        expect(local('//evil.example/x')).toBeNull();
        expect(localPathFromHref(undefined)).toBeNull();
    });
});
