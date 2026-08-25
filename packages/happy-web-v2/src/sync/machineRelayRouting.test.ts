import { describe, expect, it } from 'vitest';
import { isMachineRealtimeEvent, shouldIgnoreLegacyRealtime } from './machineRelayRouting';

describe('machine relay routing', () => {
    it('routes only the latency-sensitive terminal events away from control', () => {
        expect(isMachineRealtimeEvent('terminal-input')).toBe(true);
        expect(isMachineRealtimeEvent('terminal-resize')).toBe(true);
        expect(isMachineRealtimeEvent('update')).toBe(false);
        expect(isMachineRealtimeEvent('clipboard-push')).toBe(false);
    });

    it('drops compatibility-path duplicates only while regional relay is connected', () => {
        expect(shouldIgnoreLegacyRealtime('terminal-output', 'm1', true)).toBe(true);
        expect(shouldIgnoreLegacyRealtime('terminal-output', 'm1', false)).toBe(false);
        expect(shouldIgnoreLegacyRealtime('update', 'm1', true)).toBe(false);
        expect(shouldIgnoreLegacyRealtime('terminal-output', undefined, true)).toBe(false);
    });
});
