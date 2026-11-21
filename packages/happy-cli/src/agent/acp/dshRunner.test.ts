import { describe, expect, it } from 'vitest';
import {
    DSH_INSTALL_COMMAND,
    dshAutoApproves,
    dshFailureHint,
    dshPrerequisiteProblem,
    dshSetupMessage,
    dshSpawnRefusal,
    nodeMeetsDshMinimum,
    parseNodeVersion,
} from './dshRunner';
import { resolveAcpAgentConfig } from './acpAgentConfig';

describe('dsh runner prerequisites (B-952)', () => {
    it('parses node --version output', () => {
        expect(parseNodeVersion('v24.9.0\n')).toEqual([24, 9, 0]);
        expect(parseNodeVersion('22.23.2')).toEqual([22, 23, 2]);
        expect(parseNodeVersion('')).toBeNull();
        expect(parseNodeVersion(null)).toBeNull();
        expect(parseNodeVersion('node: not found')).toBeNull();
    });

    it('requires Node 24.9 or newer', () => {
        expect(nodeMeetsDshMinimum('v24.9.0')).toBe(true);
        expect(nodeMeetsDshMinimum('v24.22.3')).toBe(true);
        expect(nodeMeetsDshMinimum('v25.0.0')).toBe(true);
        expect(nodeMeetsDshMinimum('v24.8.9')).toBe(false);
        expect(nodeMeetsDshMinimum('v22.23.2')).toBe(false);
        expect(nodeMeetsDshMinimum(null)).toBe(false);
    });

    it('reports a missing dsh before the Node version, and nothing when both are fine', () => {
        expect(dshPrerequisiteProblem(false, 'v24.9.0')).toEqual({ kind: 'missing' });
        expect(dshPrerequisiteProblem(true, 'v22.23.2\n')).toEqual({ kind: 'node-too-old', nodeVersion: 'v22.23.2' });
        expect(dshPrerequisiteProblem(true, null)).toEqual({ kind: 'node-too-old', nodeVersion: null });
        expect(dshPrerequisiteProblem(true, 'v24.9.1')).toBeNull();
    });

    it('says exactly how to fix each problem', () => {
        expect(dshSetupMessage({ kind: 'missing' })).toContain(DSH_INSTALL_COMMAND);
        const old = dshSetupMessage({ kind: 'node-too-old', nodeVersion: 'v22.23.2' });
        expect(old).toContain('Node.js 24.9.0 or newer');
        expect(old).toContain('Node.js v22.23.2');
        expect(old).toContain('nvm install 24');
        expect(dshSetupMessage({ kind: 'node-too-old', nodeVersion: null })).toContain('no Node.js');
        expect(dshSpawnRefusal({ kind: 'missing' })).toContain(DSH_INSTALL_COMMAND);
        expect(dshSpawnRefusal({ kind: 'node-too-old', nodeVersion: 'v22.1.0' })).toContain('v22.1.0');
    });

    it('turns dsh failures into actionable hints and leaves the rest alone', () => {
        expect(dshFailureHint('spawn dsh ENOENT')).toContain(DSH_INSTALL_COMMAND);
        expect(dshFailureHint('llm-deepseek: no API key for provider route "deepseek-official"')).toContain('DEEPSEEK_API_KEY');
        expect(dshFailureHint('MISSING_CREDENTIAL')).toContain('no API key');
        expect(dshFailureHint('https://api.deepseek.com/models answered HTTP 401')).toContain('rejected the API key');
        // dsh 0.2.2-rc.5's real turn failure for a bad key (key masked by dsh).
        expect(dshFailureHint('Internal error: turn failed: Authentication Fails, Your api key: ****abcd is invalid')).toContain('rejected the API key');
        expect(dshFailureHint('spawn pi-acp ENOENT')).toBeNull();
        expect(dshFailureHint('some other failure')).toBeNull();
        expect(dshFailureHint(undefined)).toBeNull();
    });

    it('auto-approves permission asks only in bypass mode', () => {
        expect(dshAutoApproves('bypassPermissions')).toBe(true);
        expect(dshAutoApproves('yolo')).toBe(true);
        expect(dshAutoApproves('default')).toBe(false);
        expect(dshAutoApproves('acceptEdits')).toBe(false);
        expect(dshAutoApproves('plan')).toBe(false);
        expect(dshAutoApproves(undefined)).toBe(false);
    });

    it('runs the ACP profile of dsh', () => {
        expect(resolveAcpAgentConfig(['dsh'])).toEqual({ agentName: 'dsh', command: 'dsh', args: ['--profile', 'acp'] });
    });
});

describe('dsh tool kinds (B-952)', () => {
    it('maps dsh tool names to standard ACP kinds for the Web tool cards', async () => {
        const { dshToolKind } = await import('./dshRunner');
        const { deriveAcpToolArgs } = await import('./acpToolArgs');
        expect(dshToolKind('bash')).toBe('execute');
        expect(dshToolKind('read')).toBe('read');
        expect(dshToolKind('apply_patch')).toBe('edit');
        expect(dshToolKind('grep')).toBe('search');
        expect(dshToolKind('web_fetch')).toBe('fetch');
        expect(dshToolKind('todo_write')).toBeNull();
        expect(dshToolKind('constructor')).toBeNull();
        expect(deriveAcpToolArgs({ title: 'bash', kind: 'other', rawInput: { command: 'ls' } }, { agentName: 'dsh' }))
            .toEqual({ acpTitle: 'bash', acpKind: 'execute', rawInput: { command: 'ls' } });
        expect(deriveAcpToolArgs({ title: 'subagent', kind: 'other' }, { agentName: 'dsh' })).toEqual({ acpTitle: 'subagent', acpKind: 'other' });
        // Other agents keep the kind they sent.
        expect(deriveAcpToolArgs({ title: 'bash', kind: 'other' }, { agentName: 'opencode' }).acpKind).toBe('other');
    });
});
