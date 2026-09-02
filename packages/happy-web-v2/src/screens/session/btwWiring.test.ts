import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('/btw wiring (B-282)', () => {
    it('the composer intercepts /btw before any send path', () => {
        const source = read('./AgentInput.tsx');
        const intercept = source.indexOf('if (routeBtw(value))');
        const firstSend = source.indexOf('sendQueuedItem(item');
        expect(intercept).toBeGreaterThan(0);
        expect(intercept).toBeLessThan(firstSend);
        expect(source).toContain('if (routeBtw(value))');
        // queued items (auto-release / edit / intervene / persisted reload) all exit through sendQueuedItem
        const queuedSend = source.indexOf('const sendQueuedItem = async');
        expect(source.indexOf('if (routeBtw(item.text))')).toBeGreaterThan(queuedSend);
        expect(source.indexOf('if (routeBtw(item.text))')).toBeLessThan(source.indexOf('await sync.sendMessage(sessionId, item.text'));
        expect(source).toContain('if (!canOfferBtw(session)) return false;');
        expect(source).toContain("command: BTW_COMMAND, description: t('session.btw.commandDescription')");
    });

    it('the detail screen hosts the panel behind ?panel=btw and gates the header button', () => {
        const source = read('./SessionDetailScreen.tsx');
        expect(source).toContain("const btwOpen = panelTab === 'btw' && btwAllowed");
        expect(source).toContain("setPanelRef.current('btw', btwOpenRef.current)");
        expect(source).toContain('<BtwPanel sessionId={id} onClose={() => setPanel(null, true)} />');
        expect(source).toContain('onToggleBtw={btwAllowed');
        expect(source).toContain('const btwAllowed = !!session && !isMirrorSession(session) && canOfferBtw(session);');
        expect(read('./ChatHeader.tsx')).toContain('ch-btw-toggle');
    });

    it('web RPC method names match the CLI handler registrations', () => {
        const ops = read('../../sync/ops.ts');
        const cli = readFileSync(new URL('../../../../happy-cli/src/claude/registerSideQuestionHandler.ts', import.meta.url), 'utf8');
        for (const method of ['btw-ask', 'btw-poll', 'btw-cancel']) {
            expect(ops).toContain(`'${method}'`);
            expect(cli).toContain(`'${method}'`);
        }
        expect(ops).toContain('throwIfRpcError(raw)');
        expect(read('../../sync/suggestionCommandItems.ts')).toContain("'btw',");
        const capability = read('./btwCommand.ts').match(/BTW_CAPABILITY = '([^']+)'/)?.[1];
        expect(capability).toBe('claude-btw-v1');
        expect(readFileSync(new URL('../../../../happy-cli/src/claude/runClaude.ts', import.meta.url), 'utf8')).toContain(`'${capability}'`);
    });
});
