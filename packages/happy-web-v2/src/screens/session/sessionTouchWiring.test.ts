import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

// B-798 PR F: the pure rules (sessionLookup, boardStripVisible, chatHeaderFoldsIdentity) are only fixes once wired.
describe('B-798 session touch wiring', () => {
    it('P1-8: an absent session is looked up by id, and the gate decides the page', () => {
        const screen = read('./SessionDetailScreen.tsx');
        expect(screen).toContain('shouldLookUpSession({ dataReady, inStore: !!session, pending: !!pending, lookup: lookupState })');
        expect(screen).toContain('sync.fetchSessionById(id)');
        expect(screen).toContain("state: result === 'missing' ? 'missing' : 'idle'");
        expect(screen).toContain('const gate = sessionGate({ dataReady, lookup: lookupState });');
        expect(screen).toContain("title={gate === 'missing' ? t('session.notFoundTitle') : t('session.loadFailedTitle')}");
        // the raw id is a developer aid, not page copy
        expect(screen).toContain('{import.meta.env.DEV && <span className="sd-loading__id mono">Session {id}</span>}');
        const sync = read('../../sync/sync.ts');
        expect(sync).toContain("if (response.status === 404) return 'missing';");
    });
    it('P2-1: the phone strip renders only through boardStripVisible', () => {
        const mobile = read('./board/BoardMobile.tsx');
        expect(mobile).toContain('{boardStripVisible(lead, c) && <div className="brf-strip">');
        expect(mobile).toContain('.get(sessionId)?.bot.root === true;');
    });
    it('P1-9: a folded header drops identity + relay and offers 「会话信息」 in ⋯', () => {
        const header = read('./ChatHeader.tsx');
        expect(header).toContain('const foldIdentity = chatHeaderFoldsIdentity(headerWidth, viewportTablet);');
        expect(header).toContain('{!editing && !foldIdentity && <div className="ch-identity">');
        expect(header).toContain('{!foldIdentity && <RelayBadge status={relayStatus} />}');
        expect(header).toContain("const infoItems: MenuItemDef[] = foldIdentity ? [{ key: 'session-info'");
        expect(header).toContain('items={[...plan.overflow.map(menuItem), ...infoItems, ...withSessionTools(sessionItems');
    });
});
