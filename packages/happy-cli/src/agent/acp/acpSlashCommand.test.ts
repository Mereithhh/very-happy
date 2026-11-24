import { describe, expect, it } from 'vitest';
import { buildAcpPrompt, isAgentSlashCommand, routeAcpUserText } from './acpSlashCommand';

describe('isAgentSlashCommand (B-727)', () => {
    it('recognizes agent commands with and without arguments', () => {
        expect(isAgentSlashCommand('/compact')).toBe(true);
        expect(isAgentSlashCommand('  /compact keep the API decisions')).toBe(true);
        expect(isAgentSlashCommand('/name My session')).toBe(true);
        expect(isAgentSlashCommand('/skill:review now')).toBe(true);
    });
    it('leaves paths, prose and non-strings alone', () => {
        expect(isAgentSlashCommand('/tmp/out.log is empty')).toBe(false);
        expect(isAgentSlashCommand('please /compact')).toBe(false);
        expect(isAgentSlashCommand('/')).toBe(false);
        expect(isAgentSlashCommand('/1st')).toBe(false);
        expect(isAgentSlashCommand(undefined)).toBe(false);
    });
});

describe('buildAcpPrompt (B-727: pi /compact reached the model as chat)', () => {
    const decorate = async (m: string) => `[project prefix]\n${m}`;
    it('sends a slash command verbatim even on the first prompt and inside a project', async () => {
        expect(await buildAcpPrompt('/compact', { todoNoteSent: false, todoNote: 'TODO NOTE', decorate })).toEqual({ prompt: '/compact', slashCommand: true });
    });
    it('keeps decorating ordinary prompts and adds the todo note once', async () => {
        expect(await buildAcpPrompt('hi', { todoNoteSent: false, todoNote: 'TODO NOTE', decorate })).toEqual({ prompt: '[project prefix]\nhi\n\nTODO NOTE', slashCommand: false });
        expect(await buildAcpPrompt('hi', { todoNoteSent: true, todoNote: 'TODO NOTE', decorate })).toEqual({ prompt: '[project prefix]\nhi', slashCommand: false });
    });
});

describe('routeAcpUserText (Owner 10-30: /compact must run or be refused by Very Happy)', () => {
    const pi = ['compact', 'name', 'session'];
    it('runs a standalone /compact as its own command, canonicalised', () => {
        expect(routeAcpUserText('/compact', pi)).toEqual({ kind: 'command', text: '/compact' });
        expect(routeAcpUserText(' ／compact 保留结论', pi)).toEqual({ kind: 'command', text: '/compact 保留结论' });
        // Nothing listed yet (agent still starting): pass it on as before.
        expect(routeAcpUserText('/compact', null)).toEqual({ kind: 'command', text: '/compact' });
    });
    it('answers for an agent whose command list has no compaction', () => {
        expect(routeAcpUserText('/compact', ['compress', 'memory'])).toEqual({ kind: 'unsupported', notice: 'This session type does not support /compact' });
    });
    it('keeps other agent commands isolated and prose as prompts', () => {
        expect(routeAcpUserText('/name Build', pi)).toEqual({ kind: 'command', text: '/name Build' });
        expect(routeAcpUserText('please /compact', pi)).toEqual({ kind: 'prompt', text: 'please /compact' });
    });
});

describe('routeAcpUserText on dsh (B-970)', () => {
    const notice = 'dsh compacts by itself';
    it('answers /compact (every spelling) with the given notice and never sends it to the model', () => {
        for (const text of ['/compact', ' /compact ', '／compact', '/Compact']) {
            expect(routeAcpUserText(text, null, { compactNotice: notice })).toEqual({ kind: 'unsupported', notice });
        }
    });
    it('leaves other text and the agents without the option as before', () => {
        expect(routeAcpUserText('compact the file', null, { compactNotice: notice })).toEqual({ kind: 'prompt', text: 'compact the file' });
        expect(routeAcpUserText('/compact', null)).toEqual({ kind: 'command', text: '/compact' });
        expect(routeAcpUserText('/compact', ['compact'], {})).toEqual({ kind: 'command', text: '/compact' });
    });
});
