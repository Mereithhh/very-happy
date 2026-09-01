import { describe, expect, it } from 'vitest';
import { attachSectionVisible, formatSessionAge, parseTmuxSessions, primaryLabelKey, tipsCardVisible, TMUX_TIPS_HINT_KEY, toggleAttachSelection } from './newTerminalAttach';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('B-273 newTerminalAttach', () => {
    it('parses the RPC payload tolerantly: bad ids/names and vh-* rows are dropped', () => {
        const out = parseTmuxSessions({ type: 'success', sessions: [
            { id: '$3', name: 'my dev', windows: 2, attached: true, activityAt: 5 },
            { id: '3', name: 'x' }, { id: '$4', name: '' }, { id: '$5', name: 'vh-abc' }, null, 'junk',
            { id: '$6', name: 'lone' },
        ] });
        expect(out).toEqual([
            { id: '$3', name: 'my dev', windows: 2, attached: true, activityAt: 5, createdAt: undefined, command: undefined, cwd: undefined },
            { id: '$6', name: 'lone', windows: 1, attached: false, activityAt: undefined, createdAt: undefined, command: undefined, cwd: undefined },
        ]);
        expect(parseTmuxSessions(undefined)).toEqual([]);
        expect(parseTmuxSessions({ error: 'Method not found' })).toEqual([]);
    });
    it('section visibility / selection / labels', () => {
        expect(attachSectionVisible(false, true, [{ id: '$1', name: 'a', windows: 1, attached: false }])).toBe(false);
        expect(attachSectionVisible(true, false, [])).toBe(false);
        expect(attachSectionVisible(true, true, [])).toBe(true);
        expect(attachSectionVisible(true, false, [{ id: '$1', name: 'a', windows: 1, attached: false }])).toBe(true);
        expect(toggleAttachSelection(null, '$1')).toBe('$1');
        expect(toggleAttachSelection('$1', '$1')).toBeNull();
        expect(toggleAttachSelection('$1', '$2')).toBe('$2');
        expect(primaryLabelKey(true)).toBe('newTerminalModal.attach');
        expect(primaryLabelKey(false)).toBe('newTerminalModal.create');
    });
    it('compact ages', () => {
        const now = 1_000_000_000;
        expect(formatSessionAge(now - 10_000, now)).toBe('now');
        expect(formatSessionAge(now - 5 * 60_000, now)).toBe('5m');
        expect(formatSessionAge(now - 3 * 3_600_000, now)).toBe('3h');
        expect(formatSessionAge(now - 3 * 86_400_000, now)).toBe('3d');
        expect(formatSessionAge(undefined, now)).toBeUndefined();
    });
    it('tips card hides once dismissed (local settings record)', () => {
        expect(tipsCardVisible(undefined)).toBe(true);
        expect(tipsCardVisible({})).toBe(true);
        expect(tipsCardVisible({ [TMUX_TIPS_HINT_KEY]: 1 })).toBe(false);
    });
    it('source contract: the modal keeps the list fetch off `busy`, skips the fs probe when attaching, and re-fetches per machine', () => {
        const src = readFileSync(join(__dirname, 'NewTerminalModal.tsx'), 'utf8');
        expect(src).toMatch(/const \[loadingSessions, setLoadingSessions\] = useState\(false\)/);
        expect(src).not.toMatch(/setBusy\(true\);\s*\n\s*machineListTmuxSessions/);
        expect(src).toMatch(/if \(attachSelected\) \{[\s\S]*?createTerminalAt\(navigate, machineId, \{ attachTmux/);
        expect(src.indexOf('if (attachSelected) {')).toBeLessThan(src.indexOf('machineFsList(machineId, guess)'));
        expect(src).toMatch(/\}, \[machineId, attachSupported\]\);/);
        expect(src).toMatch(/\(!!attachSelected \|\| trimmed\.length > 0\)/);
    });
});
