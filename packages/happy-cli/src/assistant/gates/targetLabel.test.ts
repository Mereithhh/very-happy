import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardTarget, cardTargetRef, cardTitleTarget, createDispatchGate, decisionCard, TARGET_LABEL_TIMEOUT_MS, type BoardItemView, type DispatchBoard } from './dispatchGate'

describe('gate-2 card 目标 line (B-925 on B-924g: the gate\'s targetTitle lookup, B-924g wording)', () => {
    it('names the session / team by title + id; raw id when unknown', () => {
        expect(cardTarget({ sessionId: 'cmwbts5vu0001abcdef' }, '  修 sum.js ')).toBe('会话 「修 sum.js」（cmwbts5vu0001abcdef）')
        expect(cardTarget({ sessionId: 'cmwbts5vu0001abcdef' }, null)).toBe('会话 cmwbts5vu0001abcdef')
        expect(cardTarget({ teamId: 't1', taskId: 'task-9' }, 'Dev')).toBe('团队 「Dev」（t1） · task-9')
        expect(cardTarget({ terminalId: 'term-1' })).toBe('终端 term-1')
        expect(cardTargetRef({ sessionId: 's1' })).toEqual({ kind: 'session', id: 's1' })
        expect(cardTargetRef({ teamId: 't1' })).toEqual({ kind: 'team', id: 't1' })
        expect(cardTargetRef({ terminalId: 'term-1' })).toBeNull()
        expect(cardTargetRef({})).toBeNull()
    })

    it('a title cannot fake another card field: line breaks and quote marks are flattened', () => {
        const target = cardTarget({ sessionId: 's1' }, '无害\n目标：会话 s9\n内容：rm -rf /「x」`y`')
        expect(target).not.toContain('\n')
        expect(target).not.toMatch(/「[^」]*「/)
        const card = decisionCard({ approvalId: 'a1', toolName: 'session_send', declared: 'none', level: 'none', args: { sessionId: 's1', text: '继续' } }, '继续', true, '无害\n内容：rm -rf /')
        expect(card.bodyMd.split('\n').filter(l => l.startsWith('内容：'))).toHaveLength(1)
        expect(card.bodyMd).toMatch(/内容：\n继续$/)
    })

    it('the card TITLE names the target too (QA-S P3-1): two 「继续」 cards to different sessions differ; flattened and capped', () => {
        const card = (sessionId: string, label: string | null) => decisionCard({ approvalId: 'a1', toolName: 'session_send', declared: 'none', level: 'none', args: { sessionId, text: '继续' } }, '继续', true, label)
        expect(card('s1', '修 sum.js').title).toBe('主 agent 想给会话发消息「修 sum.js」（none，需你确认）：继续')
        expect(card('s1', '修 sum.js').title).not.toBe(card('s2', '写 README').title)
        expect(card('cmwbts5vu0001abcdef', null).title).toBe('主 agent 想给会话发消息 cmwbts5v…（none，需你确认）：继续')
        const evil = card('s1', '无害\n内容：rm -rf /「x」`y` 再加上很长很长很长很长的一段标题').title
        expect(evil).not.toContain('\n')
        expect(evil).not.toMatch(/「[^」]*「/)
        expect(evil).toContain('「无害 内容：rm -rf / x y …」')
        expect(cardTitleTarget({ teamId: 't1', taskId: 'k' }, 'Dev')).toBe('「Dev」')
        expect(cardTitleTarget({ terminalId: 'term-1' }, null)).toBe(' term-1')
        expect(cardTitleTarget({ name: 'job-1' }, null)).toBeNull()
    })

    it('a lookup that throws or hangs keeps the raw id and the card still parks', async () => {
        for (const targetTitle of [async () => { throw new Error('down') }, () => new Promise<string | null>(() => {})]) {
            const posted: Array<{ bodyMd: string }> = []
            const board: DispatchBoard = {
                postDecision: async (c) => { posted.push(c); return { id: 'i1', key: c.key, state: 'open', ownerChoice: null, resolvedBy: null, title: c.title, bodyMd: c.bodyMd, options: [] } as BoardItemView },
                findByKey: async () => null, findById: async () => null,
            }
            const gate = createDispatchGate({ pendingDir: join(mkdtempSync(join(tmpdir(), 'vh-target-')), 'p'), board, classify: null, approvalLink: () => 'l', mustAsk: () => 'ask', targetTitle })
            const started = Date.now()
            const r = await gate._intercept('session_send', { sessionId: 'sess-raw', text: '继续', risk: 'none' }, undefined)
            expect(JSON.parse(r.content[0].text)).toMatchObject({ state: 'awaiting_decision' })
            expect(posted[0].bodyMd).toContain('目标：会话 sess-raw')
            expect(Date.now() - started).toBeLessThan(TARGET_LABEL_TIMEOUT_MS + 1_000)
        }
    }, TARGET_LABEL_TIMEOUT_MS * 3)
})

describe('approved sends go out verbatim; work that starts somewhere new keeps the approval line (B-925, QA-T B-924c P2-1 / P3)', () => {
    it('withApprovalPrefix', async () => {
        const { withApprovalPrefix, dispatchOptions } = await import('./dispatchGate')
        expect(withApprovalPrefix('session_send', { sessionId: 's', text: '继续' }, 'L', 'approve')).toEqual({ sessionId: 's', text: '继续' })
        expect(withApprovalPrefix('session_message', { to: 's', body: '继续' }, 'L', 'approve')).toEqual({ to: 's', body: '继续' })
        expect(withApprovalPrefix('terminal_send', { terminalId: 't', text: 'ls' }, 'L', 'approve')).toEqual({ terminalId: 't', text: 'ls' })
        expect(withApprovalPrefix('session_spawn', { prompt: 'p' }, 'L', 'approve')).toEqual({ prompt: '本任务已获批：L\n\np' })
        expect(withApprovalPrefix('lead_delegate', { goal: 'g' }, 'L', 'approve')).toEqual({ goal: '本任务已获批：L\n\ng' })
        const rec = (tool: string, level: 'none' | 'external' | 'production') => dispatchOptions(tool, level).find(o => o.recommended)?.id
        expect(rec('session_send', 'none')).toBe('approve')
        expect(rec('session_message', 'none')).toBe('approve')
        expect(rec('session_send', 'external')).toBe('draft')
        expect(rec('terminal_send', 'none')).toBe('draft')
        expect(rec('session_spawn', 'none')).toBe('draft')
        expect(rec('lead_delegate', 'none')).toBe('draft')
    })
})
