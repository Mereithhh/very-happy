import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { metaAgentVariantSupported } from './metaAgentOption';
import { SESSION_AGENTS } from './agentAvailability';

const modal = readFileSync(new URL('../screens/sessions/NewSessionModal.tsx', import.meta.url), 'utf8');

describe('metaAgentVariantSupported', () => {
    it('offers the meta-agent variant for pi only', () => {
        expect(metaAgentVariantSupported('pi')).toBe(true);
    });

    it('never offers it for claude (its meta agent is the /assistant singleton) nor the other current agents', () => {
        expect(metaAgentVariantSupported('claude')).toBe(false);
        // Explicit list on purpose: SESSION_AGENTS gains 'pi' with the pi runner, and pi is the
        // one agent that IS offered. Every other current agent must stay false.
        for (const agent of ['codex', 'gemini', 'openclaw'] as const) {
            expect(metaAgentVariantSupported(agent)).toBe(false);
        }
        for (const agent of SESSION_AGENTS) {
            expect(metaAgentVariantSupported(agent)).toBe(agent === ('pi' as string));
        }
        expect(metaAgentVariantSupported('')).toBe(false);
        expect(metaAgentVariantSupported('Pi')).toBe(false);
    });
});

describe('NewSessionModal meta-agent option', () => {
    it('renders the checkbox only when the gate allows it', () => {
        expect(modal).toContain('const metaAgentOffered = metaAgentVariantSupported(agent);');
        expect(modal).toContain('{metaAgentOffered && (\n              <label className="ns-check">');
    });

    it('sends variant assistant only when both the box is ticked and the gate allows it — never bare', () => {
        expect(modal).toContain("...(metaAgent && metaAgentOffered ? { variant: 'assistant' } : {}),");
        expect(modal.match(/variant: 'assistant'/g)).toHaveLength(1);
    });
});
