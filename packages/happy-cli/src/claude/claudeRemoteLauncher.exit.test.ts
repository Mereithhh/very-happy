/**
 * B-939d — QA-T R67 P2: a stored project message was acked as delivered while
 * the process was stopping, though the model never read it.
 *
 * Sequence (wrapper log 2026-11-17 19:03): the stored message P1 is routed into
 * the queue; `sessions stop` → SIGTERM → runClaude's exit cleanup; Claude Code
 * is terminated and the Query rejects with "exited with code 143"; the
 * launcher's `while (!exitReason)` launched a NEW Query, P1 became its initial,
 * pushedInitial → onPromptPushed → handed → POST /delivered; then the process
 * exited. Unread cleared on the server, the model never saw P1.
 *
 * Drives the real launcher loop and the real Session/project injector; only
 * claudeRemote (the Claude Code process) and the projects HTTP client are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSessionContext } from '@slopus/happy-wire';

const projectsClient = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/projects/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/projects/client')>()),
    sharedProjectsClient: () => projectsClient.current,
}));
const remote = vi.hoisted(() => ({ impl: null as null | ((opts: any) => Promise<void>), calls: 0 }));
vi.mock('./claudeRemote', () => ({
    claudeRemote: vi.fn(async (opts: any) => { remote.calls++; await remote.impl!(opts); }),
}));
vi.mock('@/utils/secureFiles', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/secureFiles')>()),
    ensurePrivateDirectory: vi.fn(async () => {}),
}));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

const project = { id: 'p1', name: 'p', goal: null, instructions: 'x', instructionsVersion: 1 };
const ctx = (over: Partial<ProjectSessionContext> = {}): ProjectSessionContext => ({ project, via: 'explicit', team: null, decisions: [], log: [], sessions: [], unread: [], asOf: 1000, previousReadAt: 0, ...over });

function fakeProjectsClient() {
    return {
        isDisabled: vi.fn(() => false),
        context: vi.fn(async () => ctx({ unread: [{ id: 'p1-stored', fromSessionId: 'sender-a', body: 'P1 from A', createdAt: 1 }] })),
        digest: vi.fn(async () => ({ projectId: 'p1', name: 'p', instructions: null, decisions: [], revoked: [], messages: [], asOf: 2000 })),
        presence: vi.fn(async () => ({ memberships: {} })),
        delivered: vi.fn(async () => ({ delivered: 1 })),
        membership: vi.fn(), note: vi.fn(), revoke: vi.fn(), message: vi.fn(),
    };
}

/** An ApiSessionClient stand-in: records rpc handlers and routed peer messages; everything else is a no-op. */
function fakeApiClient() {
    const handlers = new Map<string, (...args: any[]) => any>();
    const routed: { text: string; localKey: string }[] = [];
    const known: Record<string, any> = {
        sessionId: 'vh-session-b',
        keepAlive: vi.fn(),
        getMetadata: () => ({}),
        rpcHandlerManager: { registerHandler: (name: string, fn: any) => handlers.set(name, fn) },
        routeLocalSessionPeer: (text: string, localKey: string) => routed.push({ text, localKey }),
        readLogTail: vi.fn(async () => []),
        promptQueueHasPending: () => false,
        closeClaudeSessionTurn: vi.fn(() => true),
        sendSessionEvent: vi.fn(),
        sendQueueCancelReason: vi.fn(),
        on: vi.fn(), off: vi.fn(), emit: vi.fn(),
    };
    const client = new Proxy(known, {
        get: (target, prop) => (prop in target ? target[prop as string] : (prop === 'then' ? undefined : vi.fn())),
    });
    return { client, handlers, routed, known };
}

function makeSession(apiClient: any) {
    return new Session({
        api: { notificationProducer: () => null, push: () => ({ sendSessionNotification: vi.fn(), sendTurnFailedNotification: vi.fn() }) } as any,
        client: apiClient,
        path: '/tmp/b939d-nonexistent',
        logPath: '/tmp/b939d.log',
        sessionId: 'claude-b',
        mcpServers: {},
        messageQueue: new MessageQueue2<any>((mode) => hashObject(mode)),
        onModeChange: vi.fn(),
        hookSettingsPath: '/tmp/b939d-settings.json',
    });
}

describe('B-939d: a process that is exiting starts no new Query and acks no stored message', () => {
    let pc: ReturnType<typeof fakeProjectsClient>;
    beforeEach(() => {
        pc = fakeProjectsClient();
        projectsClient.current = pc;
        remote.calls = 0;
        remote.impl = null;
    });
    afterEach(() => { vi.clearAllMocks(); });

    async function routedStoredMessage(session: Session, routed: { localKey: string }[]) {
        // B-939c: the stored message is routed to this session as a session message (the queue in production).
        await session.projectInjector.decorate('owner text');
        expect(routed.map((r) => r.localKey)).toEqual(['project-msg-p1-stored']);
        expect(pc.delivered).not.toHaveBeenCalled();
        return routed[0].localKey;
    }

    it('QA-T sequence: termination signal → Claude Code exits 143 → no relaunch, the routed stored message is not acked', async () => {
        const { client, handlers, routed, known } = fakeApiClient();
        const session = makeSession(client);
        const key = await routedStoredMessage(session, routed);

        remote.impl = async (opts) => {
            if (remote.calls === 1) {
                // runClaude's SIGTERM cleanup (beginExit is its first step), then
                // terminateSurvivors kills Claude Code: the Query rejects with 143.
                session.beginExit();
                throw new Error('Claude Code process exited with code 143');
            }
            // A relaunched Query: P1 is its initial — pushedInitial().
            opts.onPromptPushed?.([key]);
            void handlers.get('switch')?.();
        };

        const reason = await claudeRemoteLauncher(session);
        expect(reason).toBe('exit');
        expect(remote.calls).toBe(1);
        expect(pc.delivered).not.toHaveBeenCalled();
        // Not reported as a failed turn either: the stop was asked for.
        expect(known.closeClaudeSessionTurn).not.toHaveBeenCalledWith('failed', expect.anything());
        session.cleanup();
    });

    it('a prompt pushed into the live Query after the exit began is not acked', async () => {
        const { client, handlers, routed } = fakeApiClient();
        const session = makeSession(client);
        const key = await routedStoredMessage(session, routed);

        remote.impl = async (opts) => {
            if (remote.calls > 1) {
                // Bounds the test when the relaunch guard is broken too.
                void handlers.get('switch')?.();
                return;
            }
            session.beginExit();
            opts.onPromptPushed?.([key]);
            throw new Error('Claude Code process exited with code 143');
        };

        expect(await claudeRemoteLauncher(session)).toBe('exit');
        expect(pc.delivered).not.toHaveBeenCalled();
        session.cleanup();
    });

    it('control: without an exit, a pushed stored message is acked once', async () => {
        const { client, handlers, routed } = fakeApiClient();
        const session = makeSession(client);
        const key = await routedStoredMessage(session, routed);

        remote.impl = async (opts) => {
            opts.onPromptPushed?.([key]);
            void handlers.get('switch')?.();
        };

        expect(await claudeRemoteLauncher(session)).toBe('switch');
        expect(pc.delivered).toHaveBeenCalledTimes(1);
        expect(pc.delivered).toHaveBeenCalledWith('vh-session-b', ['p1-stored']);
        session.cleanup();
    });
});
