/**
 * AskUserQuestion pure helpers (B-100).
 *
 * The INPUT parser is the zod schema in components/tools/knownTools.tsx —
 * consumed via safeParse at the render sites (ToolView / PermissionCard), with
 * a fallback to the default JSON view when it rejects. These helpers cover the
 * answer-side logic (the answers map injected into updatedInput, and which
 * options an existing result already picked) so it stays unit-testable without
 * the React/icon imports knownTools drags in.
 */
export type AskOption = { label?: string; description?: string };
export type AskQuestion = {
    question?: string;
    header?: string;
    options?: AskOption[];
    multiSelect?: boolean;
};

export type AskAnswers = Record<number, string[]>;
export type AskAnswerPayload = Record<string, string>;

function answerPairsFromText(text: string): AskAnswerPayload | null {
    const answers: AskAnswerPayload = {};
    const pair = /"((?:\\.|[^"\\])*)"="((?:\\.|[^"\\])*)"/g;
    for (const match of text.matchAll(pair)) {
        try {
            const question = JSON.parse(`"${match[1]}"`) as unknown;
            const answer = JSON.parse(`"${match[2]}"`) as unknown;
            if (typeof question === 'string' && typeof answer === 'string' && answer.trim()) {
                answers[question] = answer;
            }
        } catch {
            // A malformed pair is ignored; another valid pair may still exist.
        }
    }
    return Object.keys(answers).length > 0 ? answers : null;
}

function asAnswerPayload(result: unknown): AskAnswerPayload | null {
    let value = result;
    if (typeof value === 'string') {
        const text = value;
        try {
            value = JSON.parse(text);
        } catch {
            return answerPairsFromText(text);
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const answers = (value as { answers?: unknown }).answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
    return Object.fromEntries(
        Object.entries(answers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
        ),
    );
}

/**
 * AskUserQuestion's SDK contract represents multi-select answers as a
 * comma-separated string.
 */
export function joinSelectedLabels(labels: string[]): string {
    return labels.filter((l) => l.trim() !== '').join(', ');
}

/** Toggle a label in a multi-select picked list (immutably). */
export function toggleLabel(picked: string[], label: string): string[] {
    return picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
}

/** Replace one question's answer without mutating answers from sibling questions. */
export function setQuestionAnswer(answers: AskAnswers, index: number, labels: string[]): AskAnswers {
    return { ...answers, [index]: labels.filter((label) => label.trim() !== '') };
}

/** A multi-question AskUserQuestion is submitted atomically once every row has an answer. */
export function areQuestionAnswersComplete(questions: AskQuestion[], answers: AskAnswers): boolean {
    return questions.length > 0 && questions.every((_, index) => (answers[index]?.length ?? 0) > 0);
}

/**
 * Build the exact AskUserQuestion `answers` payload expected by the Claude SDK:
 * each key is the original question text and each value is the selected label
 * (or comma-separated labels for a multi-select question).
 */
export function buildQuestionAnswers(questions: AskQuestion[], answers: AskAnswers): AskAnswerPayload {
    const payload: AskAnswerPayload = {};
    questions.forEach((question, index) => {
        const key = question.question;
        const value = joinSelectedLabels(answers[index] ?? []);
        if (typeof key === 'string' && key.trim() !== '' && value !== '') {
            payload[key] = value;
        }
    });
    return payload;
}

/**
 * Project the persisted AskUserQuestion tool output back into the transcript as
 * the user's visible reply. This is display-only: sending another chat message
 * here would make Claude consume the same answer twice.
 */
export function askUserQuestionDisplayAnswer(questions: AskQuestion[], result: unknown): string | null {
    const answers = asAnswerPayload(result);
    if (!answers) return null;

    const rows = questions.flatMap((question) => {
        const key = question.question;
        if (!key) return [];
        const answer = answers[key]?.trim();
        if (!answer) return [];
        return [{ label: question.header?.trim() || key, answer }];
    });
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0].answer;
    return rows.map(({ label, answer }) => `${label}: ${answer}`).join('\n');
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
