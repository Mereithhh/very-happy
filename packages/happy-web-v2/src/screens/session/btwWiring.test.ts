import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('/btw wiring (B-282)', () => {
    it('the composer intercepts /btw before any send path', () => {
        const source = read('./AgentInput.tsx');
        const intercept = source.indexOf('const btw = parseBtwCommand(value);');
        const firstSend = source.indexOf('sendQueuedItem(item');
        expect(intercept).toBeGreaterThan(0);
        expect(intercept).toBeLessThan(firstSend);
        expect(source).toContain('openBtwPanel(sessionId, btw.question)');
        expect(source).toContain("command: BTW_COMMAND, description: t('session.btw.commandDescription')");
    });

    it('the detail screen hosts the panel behind ?panel=btw and gates the header button', () => {
        const source = read('./SessionDetailScreen.tsx');
        expect(source).toContain("const btwOpen = panelTab === 'btw'");
        expect(source).toContain('<BtwPanel sessionId={id} onClose={() => setPanel(null, true)} />');
        expect(source).toContain('onToggleBtw={!mirror && canOfferBtw(session)');
        expect(read('./ChatHeader.tsx')).toContain('ch-btw-toggle');
    });

    it('web RPC method names match the CLI handler registrations', () => {
        const ops = read('../../sync/ops.ts');
        const cli = readFileSync(new URL('../../../../happy-cli/src/claude/registerSideQuestionHandler.ts', import.meta.url), 'utf8');
        for (const method of ['btw-ask', 'btw-poll', 'btw-cancel']) {
            expect(ops).toContain(`'${method}'`);
            expect(cli).toContain(`'${method}'`);
        }
        const capability = read('./btwCommand.ts').match(/BTW_CAPABILITY = '([^']+)'/)?.[1];
        expect(capability).toBe('claude-btw-v1');
        expect(readFileSync(new URL('../../../../happy-cli/src/claude/runClaude.ts', import.meta.url), 'utf8')).toContain(`'${capability}'`);
    });
});
