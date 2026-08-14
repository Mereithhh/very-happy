/**
 * AskUserQuestion pure helpers (B-100).
 *
 * The INPUT parser is the zod schema in components/tools/knownTools.tsx —
 * consumed via safeParse at the render sites (ToolView / PermissionCard), with
 * a fallback to the default JSON view when it rejects. These helpers cover the
 * answer-side logic (what message a click sends, which options an existing
 * result already picked) so it stays unit-testable without the React/icon
 * imports knownTools drags in.
 */
export type AskOption = { label?: string; description?: string };
export type AskQuestion = {
    question?: string;
    header?: string;
    options?: AskOption[];
    multiSelect?: boolean;
};

/**
 * Message text for a multi-select answer: picked labels joined with '、'.
 * A click on a single-select option sends the bare label — CLI integration
 * testing showed the model consumes a plain user message with the label text.
 */
export function joinSelectedLabels(labels: string[]): string {
    return labels.filter((l) => l.trim() !== '').join('、');
}

/** Toggle a label in a multi-select picked list (immutably). */
export function toggleLabel(picked: string[], label: string): string[] {
    return picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
}

/**
 * Best-effort detection of which option labels an already-answered tool result
 * picked: a label counts as selected when the stringified result contains it.
 * When both a label and a longer label containing it match (e.g. "Yes" inside
 * "Yes, always"), only the longer one is kept. Highlight is cosmetic — a false
 * negative just means no highlight.
 */
export function detectSelectedLabels(resultText: string, labels: (string | undefined)[]): string[] {
    if (!resultText) return [];
    const matched: string[] = [];
    for (const label of labels) {
        if (label && label.trim() !== '' && resultText.includes(label) && !matched.includes(label)) {
            matched.push(label);
        }
    }
    return matched.filter((l) => !matched.some((other) => other !== l && other.includes(l)));
}
