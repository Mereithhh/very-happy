import { describe, expect, it, vi } from 'vitest';
vi.mock('@/text', async () => await import('@/testing/englishText'));

import { clip, humanizeKey, keyValueRows, parseJsonText, rawJson } from './toolKeyValues';

/**
 * B-754: an unknown tool's arguments / JSON result become readable rows
 * instead of a pretty-printed JSON block.
 */
describe('humanizeKey', () => {
    it('reads snake, camel and kebab keys as words, keeping acronyms', () => {
        expect(humanizeKey('file_path')).toBe('File path');
        expect(humanizeKey('maxResults')).toBe('Max results');
        expect(humanizeKey('dry-run')).toBe('Dry run');
        expect(humanizeKey('task_id')).toBe('Task ID');
        expect(humanizeKey('resumedAgentId')).toBe('Resumed agent ID');
        expect(humanizeKey('timeout_ms')).toBe('Timeout ms');
        expect(humanizeKey('HTMLBody')).toBe('HTML body');
    });
});

describe('keyValueRows', () => {
    it('one row per scalar, URLs as links, paths mono, empties skipped', () => {
        const rows = keyValueRows({ query: 'pnpm filter', url: 'https://pnpm.io/filtering', path: '/home/me/app', limit: 5, dryRun: false, empty: '', none: null, list: [] });
        expect(rows.map((r) => [r.label, r.kind, r.value])).toEqual([
            ['Query', 'text', 'pnpm filter'],
            ['URL', 'link', 'https://pnpm.io/filtering'],
            ['Path', 'mono', '/home/me/app'],
            ['Limit', 'mono', '5'],
            ['Dry run', 'mono', 'false'],
        ]);
    });

    it('flattens nested objects with a › path, summarising past the depth limit', () => {
        const rows = keyValueRows({ fields: { summary: 'Route', priority: { name: 'High', id: '3' } } });
        expect(rows.map((r) => [r.key, r.label, r.value])).toEqual([
            ['fields.summary', 'Fields › Summary', 'Route'],
            ['fields.priority', 'Fields › Priority', 'High'],
        ]);
        expect(rows[1].kind).toBe('summary');
    });

    it('lists show their first items (objects by headline) and count the rest', () => {
        const rows = keyValueRows({ labels: ['web', 'ui'], tasks: [{ id: 'a', title: 'Renew passport' }, { id: 'b', title: 'Dentist' }], many: Array.from({ length: 11 }, (_, i) => `n${i}`) });
        expect(rows[0]).toMatchObject({ kind: 'list', items: ['web', 'ui'] });
        expect(rows[1].items).toEqual(['Renew passport', 'Dentist']);
        expect(rows[2].items).toHaveLength(8);
        expect(rows[2].more).toBe(3);
    });

    it('clips long single-line strings and keeps multi-line text as a block', () => {
        const rows = keyValueRows({ long: 'x'.repeat(400), body: 'line one\nline two' });
        expect(rows[0]).toMatchObject({ kind: 'text', truncated: true });
        expect(rows[0].value.length).toBeLessThanOrEqual(160);
        expect(rows[0].value.endsWith('…')).toBe(true);
        expect(rows[1]).toMatchObject({ kind: 'multiline', value: 'line one\nline two', truncated: false });
    });

    it('a string holding JSON is read as the object it encodes', () => {
        const rows = keyValueRows({ payload: '{"reason":"manual","count":2}' });
        expect(rows.map((r) => [r.label, r.value])).toEqual([['Payload › Reason', 'manual'], ['Payload › Count', '2']]);
    });

    it('a bare array result lists entries by headline; a scalar is one Value row', () => {
        expect(keyValueRows([{ title: 'A' }, { name: 'B' }]).map((r) => r.value)).toEqual(['A', 'B']);
        expect(keyValueRows('done')).toEqual([{ key: 'value', label: 'Value', kind: 'text', value: 'done' }]);
        expect(keyValueRows(null)).toEqual([]);
    });

    it('caps the row count and says how many fields are hidden', () => {
        const big = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
        const rows = keyValueRows(big);
        expect(rows).toHaveLength(25);
        expect(rows[24]).toMatchObject({ kind: 'summary', value: '6 more fields' });
    });

    it('never throws on odd input', () => {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        expect(() => keyValueRows(cyclic)).not.toThrow();
        expect(rawJson(cyclic)).toContain('[object Object]');
    });
});

describe('helpers', () => {
    it('parseJsonText only accepts JSON objects / arrays', () => {
        expect(parseJsonText(' {"a":1} ')).toEqual({ a: 1 });
        expect(parseJsonText('[1]')).toEqual([1]);
        expect(parseJsonText('{not json}')).toBeUndefined();
        expect(parseJsonText('42')).toBeUndefined();
    });
    it('clip keeps short text and ellipsises long text', () => {
        expect(clip('abc', 5)).toEqual({ text: 'abc', truncated: false });
        expect(clip('abcdefgh', 5)).toEqual({ text: 'abcd…', truncated: true });
    });
});
