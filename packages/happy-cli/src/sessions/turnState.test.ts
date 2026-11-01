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

describe('steered prompts (B-632)', () => {
    const steer = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { delivery: 'steer' } })
    it('a steer joins the running turn: its turn-end (no new turn-start) ends the latest turn', () => {
        const turn = analyzeLatestTurn(log(
            user('run sleep, then tell me the word'), ev({ t: 'turn-start' }), ev({ t: 'tool-call-start', name: 'bash' }),
            steer('the word is MANGO'),
            ev({ t: 'text', text: 'MANGO' }), ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(turn).toMatchObject({ userSeq: 4, ended: true, status: 'completed', answer: 'MANGO' })
    })

    it('a steer that fell back to the queue still waits for its own turn', () => {
        const turn = analyzeLatestTurn(log(
            user('first'), ev({ t: 'turn-start' }),
            steer('late steer'),
            ev({ t: 'turn-end', status: 'completed' }),
            ev({ t: 'turn-start' }), ev({ t: 'text', text: 'working on the steer' }),
        ))
        expect(turn.ended).toBe(false)
    })

    it('a queued (non-steer) prompt keeps the old rule', () => {
        const turn = analyzeLatestTurn(log(
            user('first'), ev({ t: 'turn-start' }), user('second'), ev({ t: 'turn-end', status: 'completed' }),
        ))
        expect(turn.ended).toBe(false)
    })
})

describe('standalone /compact and /clear (B-845)', () => {
    const service = (message: string) => ({ role: 'agent', content: { id: message, type: 'event', data: { type: 'message', message } } })

    it('a Claude /compact (no turn markers at all) ends on its compaction verdict', () => {
        expect(analyzeLatestTurn(log(user('/compact'), service('Compaction started')))).toMatchObject({ ended: false })
        expect(analyzeLatestTurn(log(user('/compact keep the plan'), service('Compaction started'), service('Compaction completed'), service('ready'))))
            .toMatchObject({ ended: true, status: 'completed', error: null })
    })

    it('a refused or failed compaction ends as failed with the reason', () => {
        expect(analyzeLatestTurn(log(user('／compact'), service('Compaction started'), service('Compaction failed: Not enough messages to compact.'))))
            .toMatchObject({ ended: true, status: 'failed', error: 'Not enough messages to compact.' })
        expect(analyzeLatestTurn(log(user('/compact'), service('Compaction failed: there is no conversation to compact yet'))))
            .toMatchObject({ ended: true, status: 'failed', error: 'there is no conversation to compact yet' })
    })

    it('B-845b: pi refusing /compact — its failed turn-end carries the agent\'s reason', () => {
        const reason = 'Internal error: pi compact failed: Nothing to compact (session too small)'
        expect(analyzeLatestTurn(log(user('/compact'), ev({ t: 'turn-start' }), service(`pi error: ${reason}`), ev({ t: 'turn-end', status: 'failed', error: reason }))))
            .toMatchObject({ ended: true, status: 'failed', error: reason })
    })

    it('a /clear ends on "Context was reset"', () => {
        expect(analyzeLatestTurn(log(user('/clear'), service('Context was reset')))).toMatchObject({ ended: true, status: 'completed' })
    })

    it('a compaction that ran as an agent turn (Codex) keeps its turn-end verdict', () => {
        expect(analyzeLatestTurn(log(
            user('/compact'), service('Compaction started'), ev({ t: 'turn-start' }), ev({ t: 'turn-end', status: 'completed' }), service('Compaction completed'),
        ))).toMatchObject({ ended: true, status: 'completed' })
        // The verdict line before the agent's own turn finished does not end it early.
        expect(analyzeLatestTurn(log(
            user('/compact'), service('Compaction completed'), ev({ t: 'turn-start' }),
        ))).toMatchObject({ ended: false })
    })

    it('only a /compact or /clear prompt is ended by these lines', () => {
        expect(analyzeLatestTurn(log(user('summarize'), ev({ t: 'turn-start' }), service('Compaction completed'))).ended).toBe(false)
        expect(analyzeLatestTurn(log(user('hi'), service('Context was reset'))).ended).toBe(false)
    })
})

describe('analyzeLatestTurn — B-850d refused prompts (queue-cancel)', () => {
    const prompt = (text: string, localId: string, seq: number): LogEntry => ({ seq, body: user(text), localId })
    const tombstone = (keys: string[], reason?: string) => ev({ t: 'queue-cancel', targetLocalKeys: keys, ...(reason ? { reason } : {}) }, 'user')
    const notice = (message: string, kind = 'agent-profile-unavailable') => ({ role: 'agent', content: { type: 'event', data: { type: 'message', message, kind } } })
    const at = (seq: number, body: unknown): LogEntry => ({ seq, body })

    it('a prompt the wrapper refused for its account ends failed, not running', () => {
        const turn = analyzeLatestTurn([
            prompt('run the report', 'p1', 1),
            at(2, tombstone(['p1'], 'failed')),
            at(3, notice('Account "Org A" is expired — sign in again or switch accounts.')),
        ])
        expect(turn.ended).toBe(true)
        expect(turn.status).toBe('failed')
        expect(turn.discarded).toBe('failed')
        expect(turn.refusal).toBe('agent-profile-unavailable')
        expect(turn.error).toBe('Not executed: Account "Org A" is expired — sign in again or switch accounts.')
    })

    it('a cleared / web-canceled queued prompt ends cancelled; the previous turn closing later is not ours', () => {
        const turn = analyzeLatestTurn([
            prompt('first', 'p0', 1),
            at(2, ev({ t: 'turn-start' })),
            prompt('second', 'p1', 3),
            at(4, tombstone(['p1'])),
            at(5, ev({ t: 'turn-end', status: 'completed' })),
        ])
        expect(turn).toMatchObject({ ended: true, status: 'cancelled', discarded: 'canceled', error: 'Not executed' })
        expect(turn.refusal).toBeUndefined()
    })

    it('a tombstone for another prompt does not end ours', () => {
        const turn = analyzeLatestTurn([prompt('mine', 'p1', 1), at(2, tombstone(['other'], 'failed'))])
        expect(turn.ended).toBe(false)
        expect(turn.discarded).toBeUndefined()
    })

    it('a replayed prompt (turn-start after the tombstone) is running again', () => {
        const turn = analyzeLatestTurn([prompt('mine', 'p1', 1), at(2, tombstone(['p1'], 'restarted')), at(3, ev({ t: 'turn-start' }))])
        expect(turn.ended).toBe(false)
        expect(turn.discarded).toBeUndefined()
    })

    it('a failed turn after a Codex switch whose account rejects the history names that refusal', () => {
        const rejected = 'This conversation\'s history cannot continue on account "ChatGPT B". Start a new session on it, or switch back to the previous account.'
        const turn = analyzeLatestTurn([
            prompt('continue', 'p1', 1),
            at(2, ev({ t: 'turn-start' })),
            at(3, notice(rejected, 'agent-profile-history-rejected')),
            at(4, ev({ t: 'turn-end', status: 'failed', error: 'encrypted content could not be verified' })),
        ])
        expect(turn).toMatchObject({ ended: true, status: 'failed', refusal: 'agent-profile-history-rejected', error: `${rejected} (encrypted content could not be verified)` })
        expect(turn.discarded).toBeUndefined()
        // Completed turns and other notices carry no refusal.
        expect(analyzeLatestTurn([prompt('x', 'p1', 1), at(2, ev({ t: 'turn-start' })), at(3, notice('warn', 'agent-profile-warning')), at(4, ev({ t: 'turn-end', status: 'failed' }))]).refusal).toBeUndefined()
        expect(analyzeLatestTurn([prompt('x', 'p1', 1), at(2, ev({ t: 'turn-start' })), at(3, notice(rejected, 'agent-profile-history-rejected')), at(4, ev({ t: 'turn-end', status: 'completed' }))]).refusal).toBeUndefined()
    })

    it('anchored (automation) prompts are matched the same way', () => {
        const turn = analyzeLatestTurn([
            prompt('[auto run r1;] go', 'a1', 1),
            prompt('human typing', 'h1', 2),
            at(3, tombstone(['a1'], 'failed')),
        ], { anchor: (body) => (body as { content: { text: string } }).content.text.startsWith('[auto run r1;]') })
        expect(turn).toMatchObject({ ended: true, status: 'failed', discarded: 'failed' })
    })
})
