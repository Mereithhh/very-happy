import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { agentKindLabel, agentKindOf, codexChildThreadIds, codexChildTitle, notableSubagentType, shortThreadId } from './agentIdentity';
import { teamMessageRoute } from '@/screens/teams/teamPresentation';

/** B-614: one agent identity across sub-agents, Codex threads, Teams and peer messages. */
describe('agent identity (B-614)', () => {
    it('maps every runner spelling to one kind, matching the sidebar glyphs', () => {
        expect(['claude', 'codex', 'pi', 'pi-acp', 'acp', 'terminal-mirror', 'cli', null].map(agentKindOf))
            .toEqual(['claude', 'codex', 'pi', 'pi', 'pi', 'terminal', 'unknown', 'unknown']);
        expect(agentKindLabel('claude')).toBe('Claude Code');
        expect(agentKindLabel('unknown')).toBeNull();
    });
    it('names only notable sub-agent types', () => {
        expect(notableSubagentType('general-purpose')).toBeNull();
        expect(notableSubagentType('background-command')).toBeNull();
        expect(notableSubagentType(' Explore ')).toBe('Explore');
    });
    it('treats only CodexCollaboration calls with receivers as child-thread pointers', () => {
        expect(codexChildThreadIds({ name: 'CodexCollaboration', input: { receiverThreadIds: ['a', 2, ''] } })).toEqual(['a']);
        expect(codexChildThreadIds({ name: 'Task', input: { receiverThreadIds: ['a'] } })).toEqual([]);
        expect(codexChildTitle({ input: { operation: 'spawn' } })).toBe('Codex · spawn');
        expect(shortThreadId('019a2b7c-thread-review')).toBe('thread-review');
    });
    it('reads team message direction from records, never prose', () => {
        const bot = (id: string) => ({ id, name: id, sessionId: null, generation: 1, root: false, managed: true, assistant: 'codex' as const, directory: null });
        const team = { bots: [bot('lead'), bot('web')], tasks: [{ id: 't', ownerBotId: 'lead' }], operations: [{ id: 'op', taskId: 't', botId: 'web' }],
            messages: [{ id: 'm1', senderBotId: 'web', recipientBotId: 'lead' }] } as unknown as TeamState;
        expect(teamMessageRoute(team, 'teams-message-m1-3')).toMatchObject({ from: { id: 'web' }, to: { id: 'lead' } });
        expect(teamMessageRoute(team, 'teams-initial-op')).toMatchObject({ from: { id: 'lead' }, to: { id: 'web' } });
        expect(teamMessageRoute(team, 'teams-message-m1-x')).toBeUndefined();
        expect(teamMessageRoute(team, null)).toBeUndefined();
    });
});
