import { describe, expect, it } from 'vitest';
import { describeArgs } from './permissionArgs';

describe('PermissionCard describeArgs (B-969)', () => {
    it('dsh bash ask shows its command, like Claude Bash', () => {
        expect(describeArgs('bash', { command: 'echo hi', description: 'd', acpTitle: 'bash', acpKind: 'execute' })).toBe('echo hi');
        expect(describeArgs('Bash', { command: 'ls' })).toBe('ls');
    });

    it('dsh write ask shows its file path', () => {
        expect(describeArgs('write', { file_path: '/tmp/a.txt', content: 'x', acpTitle: 'write', acpKind: 'edit' })).toBe('/tmp/a.txt');
    });

    it('other agents keep the JSON fallback (Gemini execute, pi gate)', () => {
        expect(describeArgs('execute', { command: 'rm f', acpKind: 'execute' })).toBe(JSON.stringify({ command: 'rm f', acpKind: 'execute' }, null, 2));
        expect(describeArgs('other', { message: 'm', acpTitle: 'ask-git-push' })).toBe(JSON.stringify({ message: 'm', acpTitle: 'ask-git-push' }, null, 2));
    });
});
