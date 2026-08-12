import { describe, it, expect } from 'vitest'
import { parseVhTerminals, VH_LIST_SESSIONS_FORMAT } from './terminals'
import { LIST_FIELD_SEP } from '@/terminal/webTerminal'

const SEP = LIST_FIELD_SEP

function line(fields: string[]): string {
    return fields.join(SEP)
}

describe('parseVhTerminals', () => {
    it('parses vh-* sessions with stored @vh_title', () => {
        const out = parseVhTerminals(
            line(['vh-abc12', '1755000000', '1755000100', '/Users/jojo/code', '部署检查', '1', '✳ deploy check']),
            'my-host',
        )
        expect(out).toEqual([{
            id: 'abc12',
            title: '部署检查',
            cwd: '/Users/jojo/code',
            createdAt: 1755000000000,
            activityAt: 1755000100000,
        }])
    })

    it('falls back to a meaningful pane title when @vh_title is empty', () => {
        const out = parseVhTerminals(
            line(['vh-abc12', '1', '2', '/tmp', '', '', '✳ fixing tests']),
            'my-host',
        )
        expect(out[0].title).toBe('fixing tests')
    })

    it('drops hostname/junk pane titles', () => {
        const out = parseVhTerminals(
            line(['vh-abc12', '1', '2', '/tmp', '', '', 'my-host']),
            'my-host',
        )
        expect(out[0].title).toBeUndefined()
    })

    it('ignores non-vh tmux sessions and malformed lines', () => {
        const stdout = [
            line(['main', '1', '2', '/tmp', '', '', 'zsh']),
            'garbage-without-separators',
            line(['vh-ok1', '1', '2', '/tmp', 't', '', 'x']),
            '',
        ].join('\n')
        const out = parseVhTerminals(stdout, 'h')
        expect(out.map((t) => t.id)).toEqual(['ok1'])
    })

    it('format has pane_title as the LAST field (embedded separators only garble the title)', () => {
        const fields = VH_LIST_SESSIONS_FORMAT.split(SEP)
        expect(fields.length).toBe(7)
        expect(fields[fields.length - 1]).toBe('#{pane_title}')
    })
})
