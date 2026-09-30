import { describe, expect, it } from 'vitest';
import { formatClaudeTimingLine } from './claudeTiming';

describe('formatClaudeTimingLine', () => {
    it('formats the cold first turn with all marks and SDK fields', () => {
        const line = formatClaudeTimingLine({
            turn: 1,
            firstTurnOfProcess: true,
            marks: { pushedAt: 1000, spawnAt: 1010, handshakeAt: 1900, initAt: 2100, firstAssistantAt: 3600.4 },
            result: { type: 'result', ttft_ms: 1450, time_to_request_ms: 120, time_to_request_from_spawn_ms: 1300, result: 'secret text' },
        });
        expect(line).toBe(
            '[CLAUDE TIMING] turn=1 firstTurnOfProcess=true pushed→spawn=10ms spawn→handshake=890ms '
            + 'handshake→init=200ms init→firstAssistant=1500ms pushed→firstAssistant=2600ms '
            + 'sdk{ttft_ms=1450,time_to_request_ms=120,time_to_request_from_spawn_ms=1300}',
        );
        expect(line).not.toContain('secret');
    });

    it('uses "-" for missing marks, absent SDK fields and inverted intervals', () => {
        const line = formatClaudeTimingLine({
            turn: 3,
            firstTurnOfProcess: false,
            marks: { pushedAt: 5000, initAt: 4000, firstAssistantAt: 5200 },
            result: { type: 'result', ttft_ms: 'nope' },
        });
        expect(line).toBe(
            '[CLAUDE TIMING] turn=3 firstTurnOfProcess=false pushed→spawn=- spawn→handshake=- '
            + 'handshake→init=- init→firstAssistant=1200ms pushed→firstAssistant=200ms '
            + 'sdk{ttft_ms=-,time_to_request_ms=-,time_to_request_from_spawn_ms=-}',
        );
    });

    it('tolerates a missing result message', () => {
        expect(formatClaudeTimingLine({ turn: 1, firstTurnOfProcess: true, marks: {} }))
            .toContain('sdk{ttft_ms=-,time_to_request_ms=-,time_to_request_from_spawn_ms=-}');
    });
});
