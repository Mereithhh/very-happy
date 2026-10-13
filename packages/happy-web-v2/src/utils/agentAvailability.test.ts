import { describe, expect, it } from 'vitest';
import { agentSetupInstruction, agentsNeedingSetup, isAgentOffered, resolveAgentAvailability } from './agentAvailability';

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

    it('enables pi only when the daemon explicitly reports the adapter present', () => {
        // Unlike codex/gemini, "unknown" is NOT available: a daemon without the
        // field predates the pi runner and would reject the spawn.
        expect(resolveAgentAvailability(undefined, 'pi').available).toBe(false);
        expect(resolveAgentAvailability({
            cliAvailability: { claude: true, codex: true, gemini: true, openclaw: true, detectedAt: 1 },
        } as any, 'pi')).toMatchObject({ available: false, externallyDetected: undefined });
        expect(resolveAgentAvailability({
            cliAvailability: { claude: true, codex: false, gemini: false, openclaw: false, pi: true, detectedAt: 1 },
        } as any, 'pi')).toMatchObject({ available: true, bundled: false, externallyDetected: true });
        expect(resolveAgentAvailability({
            cliAvailability: { claude: true, codex: false, gemini: false, openclaw: false, pi: false, detectedAt: 1 },
        } as any, 'pi').available).toBe(false);
    });

    it('hides pi from the picker on daemons that predate the runner, greys it out when reported missing', () => {
        expect(isAgentOffered(undefined, 'pi')).toBe(false);
        expect(isAgentOffered({ cliAvailability: { claude: true, codex: true, gemini: true, openclaw: true, detectedAt: 1 } } as any, 'pi')).toBe(false);
        expect(isAgentOffered({ cliAvailability: { claude: true, codex: true, gemini: true, openclaw: true, pi: false, detectedAt: 1 } } as any, 'pi')).toBe(true);
        expect(isAgentOffered({ cliAvailability: { claude: true, codex: true, gemini: true, openclaw: true, pi: true, detectedAt: 1 } } as any, 'pi')).toBe(true);
        // the older agents keep today's behaviour: always listed
        expect(isAgentOffered(undefined, 'codex')).toBe(true);
    });

    it('does not present OpenClaw gateway configuration as a shell command', () => {
        expect(agentSetupInstruction('codex')).toMatchObject({ kind: 'command', command: expect.stringContaining('@openai/codex') });
        expect(agentSetupInstruction('gemini')).toMatchObject({ kind: 'command', command: expect.stringContaining('@google/gemini-cli') });
        expect(agentSetupInstruction('openclaw')).toEqual({ kind: 'gateway' });
        expect(agentSetupInstruction('pi')).toMatchObject({ kind: 'command', command: expect.stringContaining('pi-acp@') });
    });
});

// B-596: the not-installed agents that get a click-to-reveal install row.
describe('agentsNeedingSetup', () => {
    it('lists offered agents the machine cannot start, never claude', () => {
        const metadata = { cliAvailability: { claude: false, codex: true, gemini: false, openclaw: false, pi: false, detectedAt: 1 } } as any;
        expect(agentsNeedingSetup(metadata)).toEqual(['gemini', 'openclaw', 'pi']);
    });

    it('omits pi on a daemon that never reported the field (fix is a CLI upgrade, not an install)', () => {
        const metadata = { cliAvailability: { claude: true, codex: true, gemini: true, openclaw: true, detectedAt: 1 } } as any;
        expect(agentsNeedingSetup(metadata)).toEqual([]);
    });

    it('is empty without availability data', () => {
        expect(agentsNeedingSetup(null)).toEqual([]);
        expect(agentsNeedingSetup({} as any)).toEqual([]);
    });

    it('gives pi one command for both packages', () => {
        expect(agentSetupInstruction('pi')).toEqual({ kind: 'command', command: 'npm install -g @earendil-works/pi-coding-agent pi-acp@0.0.33' });
    });
});
