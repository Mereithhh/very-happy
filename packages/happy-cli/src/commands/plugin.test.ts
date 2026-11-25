import { describe, expect, it } from 'vitest';
import { decisionPostBody, listLines, parsePluginArgs, SERVER_NO_PLUGINS } from './plugin';

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('B-974h P3-6: plugin decision post --input --multiline', () => {
    it('--multiline makes an input card with input.multiline: true (and implies --input)', () => {
        expect(decisionPostBody(parsePluginArgs(['decision', 'x', 'post', '--key', 'k', '--title', 'T', '--input', '--multiline']), 'k', 'T'))
            .toEqual({ key: 'k', kind: 'input', title: 'T', input: { multiline: true } });
        expect(decisionPostBody(parsePluginArgs(['decision', 'x', 'post', '--multiline']), 'k', 'T'))
            .toMatchObject({ kind: 'input', input: { multiline: true } });
    });

    it('single-line input, choice and notice are unchanged', () => {
        expect(decisionPostBody(parsePluginArgs(['--input']), 'k', 'T')).toEqual({ key: 'k', kind: 'input', title: 'T', input: {} });
        expect(decisionPostBody(parsePluginArgs(['--option', 'yes=Yes', '--option', 'no=No']), 'k', 'T', 'body'))
            .toEqual({ key: 'k', kind: 'choice', title: 'T', bodyMd: 'body', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] });
        expect(decisionPostBody(parsePluginArgs([]), 'k', 'T')).toEqual({ key: 'k', kind: 'notice', title: 'T' });
    });

    it('--multiline is a flag, not a value-taking option', () => {
        expect(parsePluginArgs(['decision', 'x', 'post', '--multiline', '--key', 'k']).positional).toEqual(['decision', 'x', 'post']);
    });
});

describe('B-974h P3-2: plugin list says when the server has no plugin support', () => {
    it('no support → explains it (with and without installs)', () => {
        const empty = listLines([], true, 'no').map(strip);
        expect(empty[0]).toBe(SERVER_NO_PLUGINS);
        expect(empty).toContain('No plugins installed.');
        const rows = listLines([{ id: 'hello-board', state: 'enabled', grants: ['panel'], pendingChange: false, queued: null }], true, 'no').map(strip);
        expect(rows[0]).toBe(SERVER_NO_PLUGINS);
        expect(rows[1]).toContain('hello-board');
    });

    it('supported or unknown → no notice', () => {
        for (const support of ['yes', 'unknown'] as const) {
            const lines = listLines([], true, support).map(strip);
            expect(lines).toEqual(['No plugins installed. Add one with "very-happy plugin add <manifest>".']);
        }
    });
});
