import { describe, expect, it } from 'vitest';
import {
    findSessionWrapperPids,
    isDaemonWrapperForConversation,
    mergeRestoreMetadata,
    recoverableSessionPid,
    sessionAgentConversationId,
} from './sessionProcessRecovery';

const CLAUDE_ID = '31c510f1-3e15-426e-bd98-35e4648af57c';
const wrapperCmd = (id: string, extra = '') =>
    `node --no-warnings /opt/homebrew/lib/node_modules/very-happy-cli/dist/index.mjs claude --happy-starting-mode remote --started-by daemon --resume ${id}${extra}`;
const sdkChildCmd = (id: string) =>
    `/opt/homebrew/lib/node_modules/very-happy-cli/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json --input-format stream-json --resume=${id} --permission-mode default`;

describe('recoverableSessionPid', () => {
    it('requires both persisted identity and a currently verified Happy PID', () => {
        expect(recoverableSessionPid({ hostPid: 42 } as any, new Set([42]))).toBe(42);
        expect(recoverableSessionPid({ hostPid: 42 } as any, new Set([7]))).toBeNull();
        expect(recoverableSessionPid({} as any, new Set([42]))).toBeNull();
    });
});

describe('sessionAgentConversationId', () => {
    it('picks the claude session id for claude sessions and the codex thread for codex', () => {
        expect(sessionAgentConversationId({ claudeSessionId: CLAUDE_ID } as any)).toBe(CLAUDE_ID);
        expect(sessionAgentConversationId({ flavor: 'claude', claudeSessionId: CLAUDE_ID } as any)).toBe(CLAUDE_ID);
        expect(sessionAgentConversationId({ flavor: 'codex', codexThreadId: 'thr_1' } as any)).toBe('thr_1');
        expect(sessionAgentConversationId({ flavor: 'codex', claudeSessionId: CLAUDE_ID } as any)).toBeNull();
        expect(sessionAgentConversationId({} as any)).toBeNull();
        expect(sessionAgentConversationId(undefined)).toBeNull();
    });
});

describe('isDaemonWrapperForConversation', () => {
    it('matches only daemon-spawned wrappers resuming exactly this conversation', () => {
        expect(isDaemonWrapperForConversation(wrapperCmd(CLAUDE_ID), CLAUDE_ID)).toBe(true);
        expect(isDaemonWrapperForConversation(wrapperCmd(CLAUDE_ID, ' --model fable'), CLAUDE_ID)).toBe(true);
        // A different conversation, or an id that merely shares a prefix.
        expect(isDaemonWrapperForConversation(wrapperCmd('fbba40cb-ee0d-4b65-b09f-8843fb595d0e'), CLAUDE_ID)).toBe(false);
        expect(isDaemonWrapperForConversation(wrapperCmd(`${CLAUDE_ID}0`), CLAUDE_ID)).toBe(false);
        expect(isDaemonWrapperForConversation(wrapperCmd(CLAUDE_ID), CLAUDE_ID.slice(0, 8))).toBe(false);
    });

    it('never matches the SDK child or a user-started terminal wrapper', () => {
        expect(isDaemonWrapperForConversation(sdkChildCmd(CLAUDE_ID), CLAUDE_ID)).toBe(false);
        expect(isDaemonWrapperForConversation(
            `node /opt/homebrew/lib/node_modules/very-happy-cli/dist/index.mjs claude --started-by terminal --resume ${CLAUDE_ID}`,
            CLAUDE_ID,
        )).toBe(false);
        expect(isDaemonWrapperForConversation(
            `node /opt/homebrew/lib/node_modules/very-happy-cli/dist/index.mjs claude --resume ${CLAUDE_ID}`,
            CLAUDE_ID,
        )).toBe(false);
        expect(isDaemonWrapperForConversation('', CLAUDE_ID)).toBe(false);
        expect(isDaemonWrapperForConversation(wrapperCmd(CLAUDE_ID), '')).toBe(false);
    });
});

describe('findSessionWrapperPids', () => {
    const live = [
        { pid: 25691, command: wrapperCmd(CLAUDE_ID) },
        { pid: 18234, command: sdkChildCmd(CLAUDE_ID) },
        { pid: 44604, command: wrapperCmd('fbba40cb-ee0d-4b65-b09f-8843fb595d0e') },
        { pid: 26818, command: 'node /opt/homebrew/lib/node_modules/very-happy-cli/dist/index.mjs daemon start-sync' },
    ];

    it('recovers an orphaned wrapper by its --resume command when the persisted hostPid is stale (B-272 incident shape)', () => {
        // sessions.json still says the pid of a wrapper that died days ago.
        expect(findSessionWrapperPids({ hostPid: 94251, claudeSessionId: CLAUDE_ID } as any, live)).toEqual([25691]);
    });

    it('lists the persisted pid first and then every other live wrapper of the same conversation', () => {
        const duplicated = [...live, { pid: 17092, command: wrapperCmd(CLAUDE_ID) }];
        expect(findSessionWrapperPids({ hostPid: 17092, claudeSessionId: CLAUDE_ID } as any, duplicated)).toEqual([17092, 25691]);
    });

    it('falls back to the persisted pid alone when the conversation id is unknown', () => {
        expect(findSessionWrapperPids({ hostPid: 44604 } as any, live)).toEqual([44604]);
        expect(findSessionWrapperPids({ hostPid: 1 } as any, live)).toEqual([]);
        expect(findSessionWrapperPids(undefined, live)).toEqual([]);
    });

    it('honours excludePid (the caller is never its own target)', () => {
        expect(findSessionWrapperPids({ hostPid: 25691, claudeSessionId: CLAUDE_ID } as any, live, { excludePid: 25691 })).toEqual([]);
    });

    it('matches codex wrappers by thread id', () => {
        const codexLive = [{ pid: 9, command: 'node /x/very-happy-cli/dist/index.mjs codex --resume thr_1 --started-by daemon' }];
        expect(findSessionWrapperPids({ flavor: 'codex', codexThreadId: 'thr_1' } as any, codexLive)).toEqual([9]);
    });
});

describe('mergeRestoreMetadata', () => {
    it('keeps the conversation truth but takes the new process identity (hostPid, version…)', () => {
        const stale = { path: '/private/tmp', claudeSessionId: CLAUDE_ID, hostPid: 94251, version: '0.2.84', summary: { text: 't' } } as any;
        const reported = { path: '/private/tmp', hostPid: 17092, version: '0.2.93', startedBy: 'daemon', capabilities: ['claude-steer-v1'] } as any;
        const merged = mergeRestoreMetadata(stale, reported);
        expect(merged.hostPid).toBe(17092);
        expect(merged.version).toBe('0.2.93');
        expect(merged.claudeSessionId).toBe(CLAUDE_ID);
        expect(merged.summary).toEqual({ text: 't' });
        expect(merged.capabilities).toEqual(['claude-steer-v1']);
    });

    it('returns the stale copy untouched when nothing was reported', () => {
        const stale = { hostPid: 1, claudeSessionId: CLAUDE_ID } as any;
        expect(mergeRestoreMetadata(stale, undefined)).toBe(stale);
    });

    it('does not let an undefined identity field in the report erase the stale value', () => {
        const stale = { hostPid: 1, version: '0.2.84', claudeSessionId: CLAUDE_ID } as any;
        expect(mergeRestoreMetadata(stale, { hostPid: 2 } as any)).toEqual({ hostPid: 2, version: '0.2.84', claudeSessionId: CLAUDE_ID });
    });
});
