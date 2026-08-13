import { describe, it, expect } from 'vitest'
import { applyMemorySectionUpdate, journalPathForDate } from './memory'

const DOC = `# 个人记忆

> 说明行。

## 身份与偏好

- [2026-08-01] 喜欢简短汇报

## 长期事实

（暂无）
`

describe('applyMemorySectionUpdate', () => {
    it('replaces the body of an existing middle section', () => {
        const { doc, replaced } = applyMemorySectionUpdate(DOC, '身份与偏好', '- [2026-08-13] 用中文交流')
        expect(replaced).toBe(true)
        expect(doc).toContain('## 身份与偏好\n\n- [2026-08-13] 用中文交流\n')
        // Old body gone, other sections intact.
        expect(doc).not.toContain('喜欢简短汇报')
        expect(doc).toContain('## 长期事实')
        expect(doc).toContain('（暂无）')
        expect(doc).toContain('# 个人记忆')
    })

    it('replaces the last section without touching earlier ones', () => {
        const { doc, replaced } = applyMemorySectionUpdate(DOC, '长期事实', '- [2026-08-13] 生产域名 happy.mereith.com')
        expect(replaced).toBe(true)
        expect(doc).toContain('## 长期事实\n\n- [2026-08-13] 生产域名 happy.mereith.com\n')
        expect(doc).not.toContain('（暂无）')
        expect(doc).toContain('喜欢简短汇报')
    })

    it('appends a new section when the heading does not exist', () => {
        const { doc, replaced } = applyMemorySectionUpdate(DOC, '在办事项', '- 跟进 B-051')
        expect(replaced).toBe(false)
        expect(doc.endsWith('## 在办事项\n\n- 跟进 B-051\n')).toBe(true)
        // Existing content untouched.
        expect(doc).toContain('喜欢简短汇报')
        expect(doc).toContain('## 长期事实')
    })

    it('matches headings by trimmed title', () => {
        const { replaced } = applyMemorySectionUpdate('##   身份与偏好  \n\nold\n', '身份与偏好', 'new')
        expect(replaced).toBe(true)
    })

    it('does not treat ### level-3 headings as section boundaries or targets', () => {
        const doc3 = '## A\n\nbody-a\n### sub\nsub-body\n\n## B\n\nbody-b\n'
        const { doc, replaced } = applyMemorySectionUpdate(doc3, 'A', 'new-a')
        expect(replaced).toBe(true)
        // The ### sub block belonged to A's body and is replaced with it.
        expect(doc).not.toContain('### sub')
        expect(doc).toContain('## A\n\nnew-a\n')
        expect(doc).toContain('## B\n\nbody-b')
    })

    it('handles an empty document by creating the section', () => {
        const { doc, replaced } = applyMemorySectionUpdate('', '身份与偏好', 'x')
        expect(replaced).toBe(false)
        expect(doc).toBe('## 身份与偏好\n\nx\n')
    })

    it('is idempotent for the same section+content', () => {
        const once = applyMemorySectionUpdate(DOC, '长期事实', 'stable').doc
        const twice = applyMemorySectionUpdate(once, '长期事实', 'stable').doc
        expect(twice).toBe(once)
    })
})

describe('journalPathForDate (B-063)', () => {
    it('formats local YYYY-MM-DD with zero padding', () => {
        expect(journalPathForDate('/h', new Date(2026, 0, 5))).toBe('/h/memory/journal/2026-01-05.md')
        expect(journalPathForDate('/h', new Date(2026, 11, 31))).toBe('/h/memory/journal/2026-12-31.md')
    })
})
