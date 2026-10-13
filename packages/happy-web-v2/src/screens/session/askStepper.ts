/**
 * B-564: step-by-step rules for a multi-question AskUserQuestion.
 * (Auto-advance idea and 200ms beat from Orca's native-chat ask, MIT.)
 */
import type { AskAnswers } from './askUserQuestion';

export const ASK_AUTO_ADVANCE_MS = 200;

export function isQuestionAnswered(answers: AskAnswers, index: number): boolean {
    return (answers[index]?.length ?? 0) > 0;
}

/** A single-select option pick answers the question; the card moves on — except
 *  on the last question (the batch submit stays an explicit act), and never for
 *  multi-select or the free-text 「other」 row. */
export function shouldAutoAdvance(input: { multi: boolean; other: boolean; index: number; total: number }): boolean {
    return !input.multi && !input.other && input.index < input.total - 1;
}

export type AskPrimaryAction = 'next' | 'submit';

export function askPrimaryAction(index: number, total: number): AskPrimaryAction {
    return index >= total - 1 ? 'submit' : 'next';
}

export function canTakePrimaryAction(answers: AskAnswers, index: number, total: number): boolean {
    if (askPrimaryAction(index, total) === 'next') return isQuestionAnswered(answers, index);
    for (let i = 0; i < total; i += 1) if (!isQuestionAnswered(answers, i)) return false;
    return total > 0;
}
