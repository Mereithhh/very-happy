/**
 * AskUserQuestion helper tests — B-100/B-227/B-229.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    areQuestionAnswersComplete,
    detectSelectedLabels,
    buildQuestionAnswers,
    joinSelectedLabels,
    setQuestionAnswer,
    toggleLabel,
    type AskQuestion,
} from './askUserQuestion';

describe('joinSelectedLabels', () => {
    it('uses the SDK comma-separated format for multi-select answers', () => {
        expect(joinSelectedLabels(['A', 'B'])).toBe('A, B');
    });

    it('single label passes through bare', () => {
        expect(joinSelectedLabels(['only'])).toBe('only');
    });

    it('drops empty/whitespace labels', () => {
        expect(joinSelectedLabels(['A', ' ', ''])).toBe('A');
    });
});

describe('toggleLabel', () => {
    it('adds when absent, removes when present, immutably', () => {
        const start: string[] = [];
        const one = toggleLabel(start, 'x');
        expect(one).toEqual(['x']);
        expect(start).toEqual([]);
        expect(toggleLabel(one, 'x')).toEqual([]);
    });

    it('preserves pick order', () => {
        expect(toggleLabel(['b'], 'a')).toEqual(['b', 'a']);
    });
});

describe('multi-question answers', () => {
    const questions: AskQuestion[] = [
        { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', options: [{ label: 'C' }, { label: 'D' }], multiSelect: true },
    ];

    it('keeps sibling answers editable instead of treating the first pick as a global submit', () => {
        const first = setQuestionAnswer({}, 0, ['A']);
        expect(first).toEqual({ 0: ['A'] });
        expect(areQuestionAnswersComplete(questions, first)).toBe(false);

        const both = setQuestionAnswer(first, 1, ['C', 'D']);
        expect(both).toEqual({ 0: ['A'], 1: ['C', 'D'] });
        expect(first).toEqual({ 0: ['A'] });
        expect(areQuestionAnswersComplete(questions, both)).toBe(true);
    });

    it('builds the SDK answers map with exact question-text keys', () => {
        expect(buildQuestionAnswers(questions, { 0: ['B'], 1: ['C', 'D'] })).toEqual({
            'First?': 'B',
            'Second?': 'C, D',
        });
    });

    it('omits blank or structurally invalid answers', () => {
        expect(buildQuestionAnswers([
            questions[0],
            { options: [{ label: 'orphan' }] },
        ], { 0: [' '], 1: ['orphan'] })).toEqual({});
    });
});

describe('multi-question component wiring', () => {
    const source = readFileSync(new URL('./AskUserQuestionView.tsx', import.meta.url), 'utf8');

    it('keeps single-option picks local until the whole form is submitted', () => {
        expect(source).toContain('else if (deferSubmit) onChange([o.label]);');
        expect(source).toContain('multi && !deferSubmit && !disabled');
        expect(source).toContain('onSubmit(buildQuestionAnswers(questions, answers))');
    });
});

describe('AskUserQuestion submission wiring', () => {
    const toolView = readFileSync(new URL('./ToolView.tsx', import.meta.url), 'utf8');
    const permissionCard = readFileSync(new URL('./PermissionCard.tsx', import.meta.url), 'utf8');

    it('answers the pending tool through updatedInput instead of a later chat message', () => {
        expect(toolView).toContain("'approved',\n                    { answers },");
        expect(permissionCard).toContain("'approved', { answers });");
        expect(toolView).not.toContain('sync.sendMessage');
        expect(permissionCard).not.toContain('sync.sendMessage');
    });

    it('does not expose generic approval paths that would submit an empty answer', () => {
        expect(permissionCard).toContain('{!isAskUserQuestion && (');
        expect(permissionCard).toContain('{!hasInteractiveQuestion && (');
    });
});

describe('detectSelectedLabels', () => {
    it('finds labels contained in the result text', () => {
        expect(detectSelectedLabels('User selected: Option B', ['Option A', 'Option B'])).toEqual(['Option B']);
    });

    it('prefers the longer label when one contains another', () => {
        expect(detectSelectedLabels('answer: Yes, always', ['Yes', 'Yes, always', 'No'])).toEqual(['Yes, always']);
    });

    it('empty result / no match yields empty', () => {
        expect(detectSelectedLabels('', ['A'])).toEqual([]);
        expect(detectSelectedLabels('nothing relevant', ['A'])).toEqual([]);
    });

    it('ignores undefined and blank labels', () => {
        expect(detectSelectedLabels('A picked', [undefined, ' ', 'A'])).toEqual(['A']);
    });
});
