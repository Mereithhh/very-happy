import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

/**
 * B-509 source-assertion tests: every runner drains the server-side prompt
 * queue the same way, and the session client wires the three edges. Verified
 * with scripts/dev/mutation-check.mjs (see PR).
 */
describe('B-509 server prompt queue wiring', () => {
    it.each([
        ['claude/runClaude.ts'],
        ['codex/runCodex.ts'],
        ['agent/acp/runAcp.ts'],
    ])('%s attaches the drain with the idle predicate and the MessageQueue2 wait edge', (file) => {
        const source = read(file);
        expect(source).toContain('attachPromptQueueDrain({');
        expect(source).toContain('isIdle: () => messageQueue.size() === 0 && messageQueue.isWaiting()');
        expect(source).toMatch(/messageQueue\.setOnWait\(\(\) => (promptQueueDrain|drain)\.onIdle\(\)\)/);
    });

    it('Codex and ACP re-attach the drain on every session-client swap', () => {
        for (const file of ['codex/runCodex.ts', 'agent/acp/runAcp.ts']) {
            const source = read(file);
            const swap = source.indexOf('onSessionSwap: (newSession) => {');
            expect(swap).toBeGreaterThan(-1);
            expect(source.slice(swap, swap + 400)).toContain('attachPromptQueueDrain(newSession);');
        }
    });

    it('every runner advertises the capability the web gates the server queue on', () => {
        expect(read('claude/runClaude.ts')).toContain("'claude-opus-5-5-v1', PROMPT_QUEUE_CAPABILITY]");
        expect(read('codex/runCodex.ts')).toContain('capabilities: [PROMPT_QUEUE_CAPABILITY],');
        expect(read('agent/acp/runAcp.ts')).toContain('capabilities: [PROMPT_QUEUE_CAPABILITY],');
        expect(read('utils/createSessionMetadata.ts')).toContain('...(opts.capabilities ? { capabilities: [...opts.capabilities] } : {}),');
    });

    it('the session client feeds the three edges: queue snapshot, routed inbound localId, socket connect', () => {
        const source = read('api/apiSession.ts');
        expect(source).toContain("if ((data.body as { t?: string }).t === 'prompt-queue') {");
        expect(source).toContain('this.promptQueueDrain?.onQueueChanged(Array.isArray(items) ? items.length : 0);');
        expect(source).toContain('if (sourceLocalId) this.promptQueueDrain?.onInbound(sourceLocalId);');
        expect(source).toContain("void this.promptQueueDrain?.maybeDispatch('connect');");
        // 404 = old server → unsupported (drain disables itself); nothing else is retried forever.
        expect(source).toContain("if (response.status === 404) return { kind: 'unsupported' };");
        expect(source).toContain("/prompt-queue/dispatch`");
    });
});
