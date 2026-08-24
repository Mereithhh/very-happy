import { describe, expect, it } from 'vitest';
import { agentSetupInstruction, resolveAgentAvailability } from './agentAvailability';

describe('new-session agent availability', () => {
    it('keeps bundled structured Claude available without an external claude CLI', () => {
        expect(resolveAgentAvailability({
            cliAvailability: {
                claude: false,
                codex: false,
                gemini: false,
                openclaw: false,
                detectedAt: 1,
            },
        } as any, 'claude')).toEqual({
            available: true,
            bundled: true,
            externallyDetected: false,
        });
    });

    it('disables an external agent only when a current daemon reports it missing', () => {
        const metadata = {
            cliAvailability: {
                claude: true,
                codex: false,
                gemini: true,
                openclaw: false,
                detectedAt: 1,
            },
        } as any;
        expect(resolveAgentAvailability(metadata, 'codex').available).toBe(false);
        expect(resolveAgentAvailability(metadata, 'gemini').available).toBe(true);
    });

    it('keeps older daemons without availability metadata compatible', () => {
        expect(resolveAgentAvailability(undefined, 'codex')).toMatchObject({
            available: true,
            externallyDetected: undefined,
        });
    });

    it('does not present OpenClaw gateway configuration as a shell command', () => {
        expect(agentSetupInstruction('codex')).toMatchObject({ kind: 'command', command: expect.stringContaining('@openai/codex') });
        expect(agentSetupInstruction('gemini')).toMatchObject({ kind: 'command', command: expect.stringContaining('@google/gemini-cli') });
        expect(agentSetupInstruction('openclaw')).toEqual({ kind: 'gateway' });
    });
});
