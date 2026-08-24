import { describe, expect, it } from 'vitest';
import { codexEventLogMetadata, logValueMetadata, safeCodexErrorMetadata } from './logMetadata';

describe('Codex log metadata', () => {
    const secretPrompt = 'customer source and prompt must stay private';
    const secretModel = 'private-provider/model-customer-alpha';

    it('summarizes provider events without user, model, command, or output text', () => {
        const summary = codexEventLogMetadata({
            type: 'agent_message',
            id: 'event-1',
            message: secretPrompt,
            model: secretModel,
            command: `deploy ${secretPrompt}`,
        });
        const logged = JSON.stringify(summary);
        expect(summary).toMatchObject({ eventType: 'agent_message', hasId: true });
        expect(summary.payloadBytes).toBeGreaterThan(0);
        expect(logged).not.toContain(secretPrompt);
        expect(logged).not.toContain(secretModel);
        expect(logged).not.toContain('deploy');
    });

    it('records only a value type and length for model/meta overrides', () => {
        const logged = JSON.stringify(logValueMetadata(secretModel));
        expect(logged).toContain('valueBytes');
        expect(logged).not.toContain(secretModel);
    });

    it('does not preserve an error message or response body', () => {
        const error = Object.assign(new Error(`request failed: ${secretPrompt}`), {
            name: 'ProviderError',
            code: 'BAD_REQUEST',
            response: { status: 400, data: { model: secretModel } },
        });
        const logged = JSON.stringify(safeCodexErrorMetadata(error));
        expect(logged).toContain('ProviderError');
        expect(logged).toContain('BAD_REQUEST');
        expect(logged).toContain('400');
        expect(logged).not.toContain(secretPrompt);
        expect(logged).not.toContain(secretModel);
    });

    it('does not trust arbitrary error-code strings as metadata', () => {
        const logged = JSON.stringify(safeCodexErrorMetadata({
            name: 'ProviderError',
            code: secretPrompt,
        }));
        expect(logged).toContain('codeBytes');
        expect(logged).not.toContain(secretPrompt);
    });

    it('normalizes attacker-controlled event types instead of logging them', () => {
        const logged = JSON.stringify(codexEventLogMetadata({ type: secretPrompt }));
        expect(logged).toContain('unknown');
        expect(logged).not.toContain(secretPrompt);
    });
});
