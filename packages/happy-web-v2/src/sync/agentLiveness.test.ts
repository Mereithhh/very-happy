import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Message } from './typesMessage';
import { currentTurnMessages, isAgentWorkLive } from './agentLiveness';

const base = { presence: 'online' as const, thinking: false, runningSubagentsInTurn: 0, heartbeatFresh: true };

describe('isAgentWorkLive', () => {
    it('trusts the keepAlive, not the transcript', () => {
        expect(isAgentWorkLive({ ...base, thinking: true })).toBe(true);
        expect(isAgentWorkLive(base)).toBe(false);
    });

    it('an offline session has nothing running, whatever the transcript says', () => {
        expect(isAgentWorkLive({ ...base, presence: 1_700_000_000_000, thinking: true })).toBe(false);
        expect(isAgentWorkLive({ ...base, presence: 1_700_000_000_000, runningSubagentsInTurn: 3 })).toBe(false);
        expect(isAgentWorkLive({ ...base, presence: undefined, thinking: true })).toBe(false);
    });

    it('B-260-P2 stays: a background sub-agent outlives the turn that launched it', () => {
        expect(isAgentWorkLive({ ...base, thinking: false, runningSubagentsInTurn: 1 })).toBe(true);
    });

    it('an unknown thinking flag is treated as idle, never as live', () => {
        expect(isAgentWorkLive({ ...base, thinking: undefined })).toBe(false);
    });

    it('B-322: a latched `thinking` expires once the keepAlive stops arriving', () => {
        // The hard-kill case: `finally` never ran so no interrupted tool_result
        // was written, presence is still online (server timeout is 10min + 60s
        // polling) and REST can never lower `thinking` again
        // (preserveSessionActivityFromStore). Without the lease the UI keeps
        // claiming the agent is working for ~11 minutes.
        expect(isAgentWorkLive({ ...base, thinking: true, heartbeatFresh: false })).toBe(false);
    });

    it('B-322: a stale heartbeat does not silence a background sub-agent', () => {
        // `async_launched` legitimately outlives its turn and has no heartbeat
        // of its own — the lease governs `thinking`, not that vote (B-260-P2).
        expect(isAgentWorkLive({ ...base, thinking: false, runningSubagentsInTurn: 1, heartbeatFresh: false })).toBe(true);
    });
});

function user(id: string): Message {
    return { id, kind: 'user-text', localId: null, createdAt: 1, text: id } as unknown as Message;
}
function agent(id: string): Message {
    return { id, kind: 'agent-text', createdAt: 1, text: id } as unknown as Message;
}

describe('currentTurnMessages', () => {
    it('is everything after the last user message', () => {
        const messages = [user('u1'), agent('a1'), user('u2'), agent('a2'), agent('a3')];
        expect(currentTurnMessages(messages).map((m) => m.id)).toEqual(['a2', 'a3']);
    });

    it('is the whole transcript when the user has not spoken', () => {
        const messages = [agent('a1'), agent('a2')];
        expect(currentTurnMessages(messages).map((m) => m.id)).toEqual(['a1', 'a2']);
    });

    it('is empty right after a user message', () => {
        expect(currentTurnMessages([agent('a1'), user('u1')])).toEqual([]);
    });
});

/**
 * The three consumers that each used to derive liveness on their own. A
 * regression here is exactly how B-295 shipped: the status bar, the turn
 * header and sendMessage's queued stamp all believed a `running` tool that no
 * wrapper would ever close.
 */
describe('every liveness consumer goes through the one module', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

    it('ChatList decides turn liveness with isAgentWorkLive, not a raw running tool', () => {
        const source = read('../screens/session/ChatList.tsx');
        expect(source).toContain('isAgentWorkLive({');
        expect(source).toContain('currentTurnMessages(chronological)');
        expect(source).not.toContain('useSessionRunningTool');
    });

    it('the live status bar refuses to render a tool the session is not working on', () => {
        const source = read('../screens/session/SessionLiveStatusBar.tsx');
        expect(source).toContain('isAgentWorkLive({');
        expect(source).toContain('const kind: \'tool\' | \'thinking\' | null = !agentLive');
    });

    it('sendMessage only stamps queuedAt while the agent is genuinely live', () => {
        const source = read('./sync.ts');
        // B-322: the old assertion pinned `const hasRunningTool = agentLive &&`,
        // which was dead code — `agentLive` already implies `thinking === true`,
        // so the extra term could never change the result and only cost a full
        // transcript scan per send. What must hold is that the stamp uses the
        // one liveness judgement, lease included.
        expect(source).toContain('queuedAtForSend(agentLive, source)');
        expect(source).toContain('heartbeatFresh: isHeartbeatFresh(sessionId)');
        expect(source).not.toContain('const hasRunningTool');
    });

    it('B-322: the composer asks the same question, instead of trusting a running tool', () => {
        const source = read('../screens/session/AgentInput.tsx');
        expect(source).toContain('const isWorking = isAgentWorkLive({');
        expect(source).not.toContain("session?.thinking === true || !!runningTool");
    });

    it('B-322: the heartbeat is stamped before the activity accumulator debounces it', () => {
        const source = read('./sync.ts');
        expect(source).toContain('recordHeartbeat(updateData.id, updateData.thinking === true);');
        expect(source.indexOf('recordHeartbeat(updateData.id'))
            .toBeLessThan(source.indexOf('this.activityAccumulator.addUpdate(updateData)'));
    });

    it('a stalled tool group loses the live accent instead of ticking forever', () => {
        const source = read('../screens/session/ToolGroupView.tsx');
        expect(source).toContain("return stalled ? 'stalled' : 'running'");
        expect(source).toContain("pulse={tool.state === 'running' && !isStalled}");
        expect(read('../screens/session/TurnActivityView.tsx')).toContain('stalled={!live}');
        expect(read('../screens/session/toolgroup.css')).toContain('.tg--stalled .tg-spine');
    });
});
