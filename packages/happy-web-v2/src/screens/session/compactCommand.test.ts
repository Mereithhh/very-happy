import { describe, expect, it } from 'vitest';
import { compactSupport, parseCompactCommand } from './compactCommand';

const session = (metadata: Record<string, unknown>) => ({ metadata } as never);

describe('parseCompactCommand', () => {
    it.each([
        ['/compact', '/compact'],
        ['  /compact  ', '/compact'],
        ['／compact', '/compact'],
        ['/Compact 保留测试结论', '/compact 保留测试结论'],
        ['/compact　保留', '/compact 保留'],
    ])('%j → %j', (text, canonical) => expect(parseCompactCommand(text)).toBe(canonical));

    it.each(['/compactx', 'please /compact', '/tmp/compact', 'hello'])('%j is not a command', (text) => {
        expect(parseCompactCommand(text)).toBeNull();
    });
});

describe('compactSupport (per session, AGENTS #14)', () => {
    it('Claude sessions always compact', () => {
        expect(compactSupport(session({ flavor: 'claude' }))).toBe('supported');
        expect(compactSupport(session({}))).toBe('supported');
    });
    it('Codex compacts only on a wrapper that runs it itself', () => {
        expect(compactSupport(session({ flavor: 'codex', capabilities: ['codex-steer-v1'] }))).toBe('unsupported');
        expect(compactSupport(session({ flavor: 'codex', capabilities: ['codex-compact-v1'] }))).toBe('supported');
    });
    it('ACP agents follow the commands they list', () => {
        expect(compactSupport(session({ flavor: 'acp', slashCommands: ['compact', 'name'] }))).toBe('supported');
        expect(compactSupport(session({ flavor: 'gemini', slashCommands: ['compress'] }))).toBe('unsupported');
        expect(compactSupport(session({ flavor: 'acp' }))).toBe('unknown');
    });
    it('OpenClaw never compacts', () => {
        expect(compactSupport(session({ flavor: 'openclaw' }))).toBe('unsupported');
    });
});
