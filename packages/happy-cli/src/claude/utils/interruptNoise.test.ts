import { describe, expect, it } from 'vitest';
import {
    isClaudeEdeOnlyResult,
    isClaudeEdeOnlySdkError,
    isClaudeInterruptSentinelContent,
    stripClaudeEdeDiagnosticErrors,
    stripClaudeEdeDiagnosticText,
} from './interruptNoise';

describe('Claude interrupt noise', () => {
    it('recognizes only the exact synthetic interrupt user message', () => {
        expect(isClaudeInterruptSentinelContent([
            { type: 'text', text: '[Request interrupted by user]' },
        ])).toBe(true);
        expect(isClaudeInterruptSentinelContent('[Request interrupted by user for tool use]')).toBe(true);
        expect(isClaudeInterruptSentinelContent([
            { type: 'text', text: 'The log said [Request interrupted by user]' },
        ])).toBe(false);
        expect(isClaudeInterruptSentinelContent([
            { type: 'tool_result', content: '[Request interrupted by user]' },
        ])).toBe(false);
    });

    it('recognizes EDE-only result errors but preserves mixed real failures', () => {
        expect(isClaudeEdeOnlyResult({
            errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
        })).toBe(true);
        expect(isClaudeEdeOnlyResult({
            errors: [
                '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use',
                'permission bridge crashed',
            ],
        })).toBe(false);
    });

    it('recognizes only SDK errors whose complete payload is internal EDE noise', () => {
        expect(isClaudeEdeOnlySdkError(new Error(
            'Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
        ))).toBe(true);
        expect(isClaudeEdeOnlySdkError(new Error(
            'Claude Code returned an error result: [ede_diagnostic] result_type=user; actual failure',
        ))).toBe(false);
        expect(isClaudeEdeOnlySdkError(new Error('network failed'))).toBe(false);
    });

    it('removes internal EDE entries without hiding a real adjacent failure', () => {
        expect(stripClaudeEdeDiagnosticText(
            '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use',
        )).toBeUndefined();
        expect(stripClaudeEdeDiagnosticText(
            '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use; permission bridge crashed',
        )).toBe('permission bridge crashed');
        expect(stripClaudeEdeDiagnosticText('network failed; retry exhausted'))
            .toBe('network failed; retry exhausted');

        expect(stripClaudeEdeDiagnosticErrors([
            '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use',
            'permission bridge crashed',
        ])).toEqual(['permission bridge crashed']);
    });
});
