/**
 * Pure section-level editing of the assistant's `memory/personal.md` — B-051.
 *
 * The file is organized as `## <section>` blocks. `memory_update(section,
 * content)` replaces the BODY of the matching section (heading line kept as
 * is), or appends a brand-new section at the end when the heading does not
 * exist yet. Everything outside the targeted section is preserved verbatim.
 *
 * Pure function so the replace/append semantics are unit-testable without
 * touching the filesystem (termWriteHold / boardTaskOps precedent).
 */

/** Soft size cap the assistant is told to respect (~2000 chars). The tool
 *  never refuses a write for size — it warns in the confirmation instead —
 *  but we surface the number from one shared place. */
export const PERSONAL_MEMORY_SOFT_LIMIT_CHARS = 2000

export interface MemoryUpdateResult {
    /** The updated document. */
    doc: string
    /** Whether an existing section was replaced (false = appended new). */
    replaced: boolean
}

/** Does this line open a level-2 markdown heading? Returns the trimmed title. */
function headingTitle(line: string): string | null {
    const m = /^##(?!#)\s*(.*?)\s*$/.exec(line)
    return m ? m[1] : null
}

/**
 * Replace the body of `## <section>` with `content`, or append the section.
 *
 * - Section matching is by exact (trimmed) heading title.
 * - The replaced body spans from the line after the heading up to (not
 *   including) the next `## ` heading or EOF.
 * - Content is normalized to end with a single newline and is separated from
 *   the heading by one blank line, matching the seed template's shape.
 */
export function applyMemorySectionUpdate(doc: string, section: string, content: string): MemoryUpdateResult {
    const wanted = section.trim()
    const normalizedContent = content.replace(/\s+$/, '')
    const sectionBlock = `## ${wanted}\n\n${normalizedContent}\n`

    const lines = doc.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
        if (headingTitle(lines[i]) === wanted) {
            start = i
            break
        }
    }

    if (start === -1) {
        // Append a new section at the end, separated by a blank line.
        const base = doc.replace(/\s+$/, '')
        const doc2 = base.length > 0 ? `${base}\n\n${sectionBlock}` : sectionBlock
        return { doc: doc2, replaced: false }
    }

    // Find the end of this section: next `##` heading or EOF.
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
        if (headingTitle(lines[i]) !== null) {
            end = i
            break
        }
    }

    const before = lines.slice(0, start).join('\n')
    const after = lines.slice(end).join('\n')

    let doc2 = before.length > 0 ? `${before.replace(/\s+$/, '')}\n\n` : ''
    doc2 += sectionBlock
    if (after.trim().length > 0) {
        doc2 += `\n${after.replace(/\s+$/, '')}\n`
    }
    return { doc: doc2, replaced: true }
}
