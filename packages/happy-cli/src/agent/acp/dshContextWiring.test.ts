import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** B-970: dsh's `usage_update` reaches agentState.dshContextUsage, and the wrapper says so. */
describe('dsh context usage wiring (B-970)', () => {
    it('runAcp mirrors a dsh usage_update into agentState and declares dsh-context-v1 on dsh only', () => {
        const acp = read('agent/acp/runAcp.ts');
        expect(acp).toContain("if (msg.type === 'event' && msg.name === 'usage_update' && opts.agentName === 'dsh') {\n      const usage = dshContextUsageOf(msg.payload, agentSessionId, Date.now());\n      if (usage) session.updateAgentState(state => ({ ...state, dshContextUsage: usage }));");
        expect(acp).toContain("if (opts.agentName === 'dsh') metadata.capabilities = [...metadata.capabilities, DSH_CONTEXT_CAPABILITY];");
    });
    it('AcpBackend forwards usage_update as an event', () => {
        expect(read('agent/acp/AcpBackend.ts')).toContain("if (updateType === 'usage_update') {\n      this.emit({ type: 'event', name: 'usage_update', payload: update });");
    });
});
