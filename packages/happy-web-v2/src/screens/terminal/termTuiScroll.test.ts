import { describe, expect, it } from 'vitest';
import {
    CLAUDE_JUMP_TO_LATEST,
    MAX_SGR_WHEEL_EVENTS,
    encodeSgrWheelBurst,
    latestTuiInput,
} from './termTuiScroll';

describe('encodeSgrWheelBurst', () => {
    it('encodes up/down at the pane centre with the SGR wheel buttons', () => {
        expect(encodeSgrWheelBurst(2, 80, 24)).toBe('\x1b[<64;40;12M'.repeat(2));
        expect(encodeSgrWheelBurst(-1, 81, 25)).toBe('\x1b[<65;41;13M');
    });

    it('ignores unusable deltas and bounds one realtime burst', () => {
        expect(encodeSgrWheelBurst(0.9, 80, 24)).toBe('');
        expect(encodeSgrWheelBurst(Number.NaN, 80, 24)).toBe('');
        expect(encodeSgrWheelBurst(10_000, 80, 24))
            .toBe('\x1b[<64;40;12M'.repeat(MAX_SGR_WHEEL_EVENTS));
    });
});

describe('latestTuiInput', () => {
    it('uses Claude fullscreen Ctrl+End only for a classified alternate-screen agent', () => {
        expect(latestTuiInput(true, true)).toBe(CLAUDE_JUMP_TO_LATEST);
        expect(latestTuiInput(false, true)).toBe('');
        expect(latestTuiInput(true, false)).toBe('');
    });
});
