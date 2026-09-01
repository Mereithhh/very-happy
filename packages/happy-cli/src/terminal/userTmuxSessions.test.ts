import { describe, expect, it } from 'vitest';
import { USER_SESSION_FIELD_SEP as SEP, USER_SESSIONS_FORMAT, attachStartupCommand, isSafeTmuxSessionName, parseUserSessionLine, parseUserSessions, TMUX_SESSION_ID_RE } from './userTmuxSessions';

const mk = (...f: string[]) => f.join(SEP);

describe('B-273 user tmux sessions', () => {
    it('format ends with pane_current_path (directory names may contain the separator)', () => {
        const fields = USER_SESSIONS_FORMAT.split(SEP);
        expect(fields[0]).toBe('#{session_id}');
        expect(fields[fields.length - 1]).toBe('#{pane_current_path}');
        expect(fields.length).toBe(8);
    });
    it('parses a line; epoch s → ms; attached is a count', () => {
        expect(parseUserSessionLine(mk('$3', 'my dev', '2', '1', '1700000100', '1700000000', 'vim', '/home/u/p'))).toEqual({
            id: '$3', name: 'my dev', windows: 2, attached: true, activityAt: 1700000100000, createdAt: 1700000000000, command: 'vim', cwd: '/home/u/p',
        });
        expect(parseUserSessionLine(mk('$0', 'x', '1', '0', '', '', '', ''))).toMatchObject({ attached: false, activityAt: undefined, createdAt: undefined, command: undefined, cwd: undefined });
    });
    it('a separator inside the directory only garbles the directory', () => {
        const p = parseUserSessionLine(mk('$1', 'n', '1', '0', '1', '1', 'sh', `/a${SEP}b`))!;
        expect(p.cwd).toBe(`/a${SEP}b`);
        expect(p.command).toBe('sh');
    });
    it('rejects bad ids / names and short lines', () => {
        expect(parseUserSessionLine('')).toBeUndefined();
        expect(parseUserSessionLine(mk('3', 'n', '1', '0', '1', '1', 'sh', '/'))).toBeUndefined();
        expect(parseUserSessionLine(mk('$3', '', '1', '0', '1', '1', 'sh', '/'))).toBeUndefined();
        expect(parseUserSessionLine(mk('$3', 'n', '1', '0', '1'))).toBeUndefined();
        expect(isSafeTmuxSessionName('a:b.c $ "q" 中文')).toBe(true);
        expect(isSafeTmuxSessionName('bad\x1fname')).toBe(false);
        expect(isSafeTmuxSessionName('x'.repeat(129))).toBe(false);
        expect(TMUX_SESSION_ID_RE.test('$12')).toBe(true);
        expect(TMUX_SESSION_ID_RE.test('$')).toBe(false);
        expect(TMUX_SESSION_ID_RE.test("$1'")).toBe(false);
    });
    it('list: drops vh-*, newest activity first, capped', () => {
        const out = parseUserSessions([
            mk('$1', 'vh-abc', '1', '0', '9', '1', 'sh', '/'),
            mk('$2', 'old', '1', '0', '1', '1', 'sh', '/'),
            mk('$3', 'new', '3', '1', '5', '1', 'sh', '/'),
            'garbage',
        ].join('\n'));
        expect(out.map((s) => s.name)).toEqual(['new', 'old']);
        expect(parseUserSessions(Array.from({ length: 60 }, (_, i) => mk(`$${i}`, `s${i}`, '1', '0', String(i), '1', 'sh', '/')).join('\n'), 50)).toHaveLength(50);
    });
    it('attach command: TMUX cleared, -S only with a socket, id quoted, leading space', () => {
        expect(attachStartupCommand('$4')).toBe(" TMUX= tmux attach-session -t '$4'");
        expect(attachStartupCommand('$4', "/tmp/it's/sock")).toBe(" TMUX= tmux -S '/tmp/it'\\''s/sock' attach-session -t '$4'");
        expect(() => attachStartupCommand('dev')).toThrow();
    });
});
