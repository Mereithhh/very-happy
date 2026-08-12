import { describe, it, expect } from 'vitest'
import { formatMessageBody, formatTranscript, truncateText } from './transcript'

describe('formatMessageBody', () => {
    it('formats a user text message', () => {
        expect(formatMessageBody({ role: 'user', content: { type: 'text', text: '帮我看下部署' } }))
            .toBe('user: 帮我看下部署')
    })

    it('formats an assistant text envelope', () => {
        const body = {
            role: 'session',
            content: { id: 'x', time: 1, role: 'agent', ev: { t: 'text', text: 'Deploy looks fine.' } },
        }
        expect(formatMessageBody(body)).toBe('assistant: Deploy looks fine.')
    })

    it('skips thinking text', () => {
        const body = {
            role: 'session',
            content: { id: 'x', time: 1, role: 'agent', ev: { t: 'text', text: 'hmm', thinking: true } },
        }
        expect(formatMessageBody(body)).toBeNull()
    })

    it('summarizes tool calls by name and title', () => {
        const body = {
            role: 'session',
            content: {
                id: 'x', time: 1, role: 'agent',
                ev: { t: 'tool-call-start', call: 'c1', name: 'Bash', title: 'ls -la', description: '', args: { command: 'ls -la' } },
            },
        }
        expect(formatMessageBody(body)).toBe('[tool] Bash: ls -la')
    })

    it('falls back to args when a tool call has no title', () => {
        const body = {
            role: 'session',
            content: {
                id: 'x', time: 1, role: 'agent',
                ev: { t: 'tool-call-start', call: 'c1', name: 'Read', title: '', description: '', args: { file: '/a' } },
            },
        }
        expect(formatMessageBody(body)).toBe('[tool] Read: {"file":"/a"}')
    })

    it('skips structural events (turn markers, tool-call-end)', () => {
        const env = (ev: any) => ({ role: 'session', content: { id: 'x', time: 1, role: 'agent', ev } })
        expect(formatMessageBody(env({ t: 'turn-start' }))).toBeNull()
        expect(formatMessageBody(env({ t: 'tool-call-end', call: 'c1' }))).toBeNull()
        expect(formatMessageBody(env({ t: 'turn-end', status: 'completed' }))).toBeNull()
        expect(formatMessageBody(env({ t: 'turn-end', status: 'failed' }))).toBe('[turn failed]')
    })

    it('formats ACP agent messages', () => {
        expect(formatMessageBody({ role: 'agent', content: { type: 'acp', provider: 'codex', data: { type: 'message', message: 'done' } } }))
            .toBe('assistant: done')
        expect(formatMessageBody({ role: 'agent', content: { type: 'acp', provider: 'codex', data: { type: 'reasoning', message: 'x' } } }))
            .toBeNull()
    })

    it('truncates long payloads', () => {
        const long = 'x'.repeat(900)
        const line = formatMessageBody({ role: 'user', content: { type: 'text', text: long } })!
        expect(line.length).toBeLessThan(600)
        expect(line).toContain('…[+400 chars]')
    })

    it('returns null for garbage', () => {
        expect(formatMessageBody(null)).toBeNull()
        expect(formatMessageBody('str')).toBeNull()
        expect(formatMessageBody({ role: 'weird' })).toBeNull()
    })
})

describe('formatTranscript', () => {
    it('joins formatted lines and skips nulls/undecryptables', () => {
        const out = formatTranscript([
            { role: 'user', content: { type: 'text', text: 'hi' } },
            null, // undecryptable
            { role: 'session', content: { id: '1', time: 1, role: 'agent', ev: { t: 'turn-start' } } },
            { role: 'session', content: { id: '2', time: 2, role: 'agent', ev: { t: 'text', text: 'hello' } } },
        ])
        expect(out).toBe('user: hi\nassistant: hello')
    })
})

describe('truncateText', () => {
    it('leaves short text alone', () => {
        expect(truncateText('abc', 10)).toBe('abc')
    })
    it('counts code points, not UTF-16 units', () => {
        const s = '𝒙'.repeat(10)
        expect(truncateText(s, 10)).toBe(s)
    })
})
