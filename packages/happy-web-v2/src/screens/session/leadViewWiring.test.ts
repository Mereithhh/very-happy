import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

// B-766 B-1: the lead view is wired only into the team LEAD's conversation.
describe('lead view wiring', () => {
    it('offers the switch only on the lead (root) member’s session', () => {
        expect(read('./SessionTeamContext.tsx')).toContain('toggle={membership.bot.root ? <LeadViewToggle sessionId={sessionId} /> : undefined}');
    });
    it('folds only a lead session, and only in 「只看我和负责人」', () => {
        const chat = read('./ChatList.tsx');
        expect(chat).toContain('return membership?.bot.root ? membership.team : undefined;');
        expect(chat).toContain("(leadTeam && leadView === 'owner' ? leadViewEntries(rows, turnOpenerIds(shownChronological), origin) : null)");
        // Follow / unseen badge read the keys on screen.
        expect(chat).toContain('(entries ? leadViewKeys(entries, openFolds) : rows.map((row) => row.key))');
    });
    it('anchors agent answers for 「已答 ↗」', () => {
        expect(read('./MessageView.tsx')).toContain('<div className="msg msg--agent" data-message-id={message.id}>');
        // …through the session-search jump, tinted (no terms to paint).
        expect(read('./ChatList.tsx')).toContain('requestChatJump(sessionId, { terms: [], messageId: answerId, flash: true })');
        expect(read('../search/useChatJump.ts')).toContain('if (req.flash) flashElement(found.el);');
    });
});
