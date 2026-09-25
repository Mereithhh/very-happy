import { describe, expect, it } from 'vitest'
import { analyzeLatestTurn, type LogEntry } from './turnState'

const user = (text: string) => ({ role: 'user', content: { type: 'text', text } })
const ev = (e: Record<string, unknown>, role = 'agent') => ({ role: 'session', content: { role, ev: e } })
const log = (...bodies: unknown[]): LogEntry[] => bodies.map((body, i) => ({ seq: i + 1, body }))

describe('analyzeLatestTurn (B-492)', () => {
    it('is running until a turn-end follows the latest prompt', () => {
        const turn = analyzeLatestTurn(log(user('hi'), ev({ t: 'turn-start' }), ev({ t: 'text', text: 'working' })))
        expect(turn).toMatchObject({ userSeq: 1, ended: false, status: null, answer: 'working', lastSeq: 3 })
    })

    it('ends on turn-end and reports the text after the last tool call as the answer', () => {
        const turn = analyzeLatestTurn(log(
            user('fix it'),
            ev({ t: 'turn-start' }),
            ev({ t: 'text', text: 'Let me look.' }),
            ev({ t: 'tool-call-start', name: 'Bash' }),
            ev({ t: 'text', text: 'thinking…', thinking: true }),
            ev({ t: 'text', text: 'Fixed in foo.ts.' }),
            ev({ t: 'text', text: 'Tests pass.' }),
            ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(turn).toMatchObject({ ended: true, status: 'completed', answer: 'Fixed in foo.ts.\n\nTests pass.' })
    })

    it('ignores the previous turn ending after a queued prompt', () => {
        const turn = analyzeLatestTurn(log(
            user('first'), ev({ t: 'turn-start' }),
            user('second'),
            ev({ t: 'text', text: 'first answer' }), ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(turn.ended).toBe(false)
        const done = analyzeLatestTurn(log(
            user('first'), ev({ t: 'turn-start' }),
            user('second'),
            ev({ t: 'text', text: 'first answer' }), ev({ t: 'turn-end', status: 'completed' }),
            ev({ t: 'turn-start' }), ev({ t: 'text', text: 'second answer' }), ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(done).toMatchObject({ ended: true, answer: 'second answer' })
    })

    it('does not anchor on the agent echoing a user text envelope', () => {
        const turn = analyzeLatestTurn(log(
            user('go'), ev({ t: 'turn-start' }), ev({ t: 'text', text: 'echo' }, 'user'),
            ev({ t: 'text', text: 'done' }), ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(turn).toMatchObject({ userSeq: 1, ended: true, answer: 'done' })
    })

    it('reports failed turns with their error', () => {
        const turn = analyzeLatestTurn(log(user('x'), ev({ t: 'turn-start' }), ev({ t: 'turn-end', status: 'failed', error: 'boom' })))
        expect(turn).toMatchObject({ ended: true, status: 'failed', error: 'boom', answer: '' })
    })

    it('falls back to the last marker when the window has no prompt', () => {
        expect(analyzeLatestTurn(log(ev({ t: 'text', text: 'a' }), ev({ t: 'turn-end', status: 'completed' }))).ended).toBe(true)
        expect(analyzeLatestTurn(log(ev({ t: 'turn-start' }), ev({ t: 'text', text: 'a' }))).ended).toBe(false)
        expect(analyzeLatestTurn([])).toMatchObject({ ended: false, lastSeq: 0, userSeq: null })
    })

    it('reads ACP (pi / gemini) agent messages as the answer', () => {
        const turn = analyzeLatestTurn(log(
            user('q'), ev({ t: 'turn-start' }),
            { role: 'agent', content: { type: 'acp', provider: 'pi', data: { type: 'message', message: 'pi says hi' } } },
            ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(turn).toMatchObject({ ended: true, answer: 'pi says hi' })
    })

    it('skips undecryptable entries', () => {
        const turn = analyzeLatestTurn(log(user('q'), null, ev({ t: 'turn-start' }), ev({ t: 'text', text: 'ok' }), ev({ t: 'turn-end', status: 'completed' })))
        expect(turn).toMatchObject({ ended: true, answer: 'ok' })
    })
})

describe('analyzeLatestTurn with an anchor (B-496)', () => {
    const user = (seq: number, text: string) => ({ seq, body: { role: 'user', content: { type: 'text', text } } })
    const ev = (seq: number, ev: Record<string, unknown>) => ({ seq, body: { role: 'session', content: { role: 'agent', ev } } })
    const anchor = (body: unknown) => (body as any)?.content?.text?.startsWith('[run r1]') === true
    it('anchors on the matching prompt even when a human typed later, and stops once that turn ended', () => {
        const entries = [
            user(1, '[run r1] do it'), ev(2, { t: 'turn-start' }), ev(3, { t: 'text', text: 'automation answer' }), ev(4, { t: 'turn-end', status: 'completed' }),
            user(5, 'hi from a human'), ev(6, { t: 'turn-start' }), ev(7, { t: 'text', text: 'human answer' }), ev(8, { t: 'turn-end', status: 'completed' }),
        ]
        expect(analyzeLatestTurn(entries, { anchor })).toMatchObject({ userSeq: 1, ended: true, answer: 'automation answer' })
        expect(analyzeLatestTurn(entries)).toMatchObject({ userSeq: 5, answer: 'human answer' })
    })
    it('keeps waiting while the anchored turn is queued behind a human prompt', () => {
        const entries = [user(1, 'human first'), ev(2, { t: 'turn-start' }), user(3, '[run r1] do it'), ev(4, { t: 'text', text: 'human answer' }), ev(5, { t: 'turn-end', status: 'completed' })]
        expect(analyzeLatestTurn(entries, { anchor })).toMatchObject({ userSeq: 3, ended: false })
        const later = [...entries, ev(6, { t: 'turn-start' }), ev(7, { t: 'text', text: 'ours' }), ev(8, { t: 'turn-end', status: 'completed' })]
        expect(analyzeLatestTurn(later, { anchor })).toMatchObject({ ended: true, answer: 'ours' })
    })
})
