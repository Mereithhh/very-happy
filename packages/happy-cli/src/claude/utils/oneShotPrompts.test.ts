import { describe, expect, it } from 'vitest';
import {
    BOARD_ANALYZER_PROMPT_PREFIX,
    isVeryHappyOneShotPrompt,
    TITLE_PROMPT_PREFIX,
} from './oneShotPrompts';
import { buildPrompt } from './titleGenerator';

describe('very-happy one-shot prompt markers (B-290)', () => {
    it('recognises the helpers and leaves human prompts alone', () => {
        expect(isVeryHappyOneShotPrompt(`${TITLE_PROMPT_PREFIX} (match the message's language).`)).toBe(true);
        expect(isVeryHappyOneShotPrompt(`\n  ${BOARD_ANALYZER_PROMPT_PREFIX} Analyze this…`)).toBe(true);
        expect(isVeryHappyOneShotPrompt('Summarize this file for me')).toBe(false);
        expect(isVeryHappyOneShotPrompt('')).toBe(false);
    });

    it('stays in sync with the prompt the title generator actually sends', () => {
        // If this fails, the prompt was edited without updating the shared
        // marker — the import picker would start listing title one-shots again.
        expect(buildPrompt('hello world').startsWith(TITLE_PROMPT_PREFIX)).toBe(true);
        expect(isVeryHappyOneShotPrompt(buildPrompt('hello world'))).toBe(true);
    });
});
