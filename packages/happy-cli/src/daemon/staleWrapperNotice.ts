/**
 * B-911 — the 「需要我决策」 card for a wrapper stuck on an old CLI.
 *
 * A wrapper the daemon cannot prove idle by check-in (`manual` / `no-report`:
 * team, automation and pre-B-852 wrappers; `no-check-in`) is never restarted
 * automatically, and the only sign used to be a banner inside the session — a
 * 0.2.181 lead stayed behind for three weeks. When the daemon classifies one,
 * it posts one attention item in that session (key `stale-wrapper`, kind
 * `todo`, source `automation`): the server pushes it once (`pushedAt`, the
 * user's push settings), and the Web card offers 「本轮结束后重启」
 * (`restart-session` + `whenIdle`).
 *
 * Lifecycle (all best-effort; a server without the board just has no card):
 * - stuck  → post (a repost of an open item only refreshes it, no second push);
 *   an item the owner closed is left alone — the owner already decided;
 * - queued → `in_progress` with a line saying so; a failed restart → `open` again;
 * - restarted / caught up → resolved `done`; the wrapper went away → `superseded`.
 */
import type { AttentionItem } from '@slopus/happy-wire';
import type { AttentionClient } from '@/attention/client';
import { AttentionUnsupportedError } from '@/attention/client';

export const STALE_WRAPPER_ITEM_KEY = 'stale-wrapper';

export interface StaleWrapperFacts {
    /** Session title (or folder) as the owner knows it. */
    name: string;
    from: string;
    target: string;
    reason: string;
}

const clipName = (name: string) => name.length > 40 ? `${name.slice(0, 39)}…` : name;

/** The item as posted (Chinese like every server-written item; the Web words it in the reader's language). */
export function staleWrapperItem(sessionId: string, facts: StaleWrapperFacts) {
    const why = facts.reason === 'no-check-in'
        ? '它启动以来一直没向 daemon 报告过空闲'
        : '它是团队、自动化或旧版会话，不向 daemon 报告空闲';
    return {
        sessionId,
        source: 'automation' as const,
        kind: 'todo' as const,
        key: STALE_WRAPPER_ITEM_KEY,
        title: `会话「${clipName(facts.name)}」还在用 CLI ${facts.from}，没法自动升级到 ${facts.target}`.slice(0, 120),
        bodyMd: [
            `本机已经装了 CLI ${facts.target}，但这个会话还跑在 ${facts.from} 上：${why}，所以 daemon 不会自动重启它，新版的修复和工具在它这里都不生效。`,
            '',
            '点「本轮结束后重启」：daemon 会等它这一轮做完、空闲下来再原地重启，对话历史、模型和思考强度都保留。正在进行的这一轮不会被打断。',
        ].join('\n'),
    };
}

export interface StaleWrapperNoticeDeps {
    client: () => AttentionClient | null;
    log?: (message: string) => void;
}

export function createStaleWrapperNotices(deps: StaleWrapperNoticeDeps) {
    /** (session → target) already handled this daemon run. */
    const notified = new Map<string, string>();

    async function find(client: AttentionClient, sessionId: string): Promise<AttentionItem | null> {
        const { items } = await client.list({ sessionId, state: 'all', limit: 200 });
        return items.find(item => item.key === STALE_WRAPPER_ITEM_KEY) ?? null;
    }
    async function guarded(what: string, sessionId: string, work: (client: AttentionClient) => Promise<void>): Promise<void> {
        const client = deps.client();
        if (!client) return;
        try {
            await work(client);
        } catch (error) {
            if (error instanceof AttentionUnsupportedError) return;
            deps.log?.(`[stale-wrapper] ${what} for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const active = (item: AttentionItem | null): item is AttentionItem => !!item && (item.state === 'open' || item.state === 'in_progress');

    return {
        /** Entered `manual` (restartable): one card, one push. */
        stuck(sessionId: string, facts: StaleWrapperFacts): Promise<void> {
            if (notified.get(sessionId) === facts.target) return Promise.resolve();
            notified.set(sessionId, facts.target);
            return guarded('post', sessionId, async (client) => {
                const existing = await find(client, sessionId);
                // The owner closed it (「暂不」 / 标为完成): that was the decision; never nag again.
                if (existing && existing.state !== 'open' && existing.state !== 'in_progress' && existing.resolvedBy === 'owner') return;
                const body = staleWrapperItem(sessionId, facts);
                if (active(existing)) {
                    if (existing.title !== body.title) await client.patch(existing.id, { title: body.title, bodyMd: body.bodyMd });
                    return;
                }
                await client.post(body);
                deps.log?.(`[stale-wrapper] ${sessionId}: card posted (${facts.from} → ${facts.target})`);
            });
        },
        /** The owner's 「本轮结束后重启」 was accepted by the daemon. */
        queued(sessionId: string): Promise<void> {
            return guarded('mark queued', sessionId, async (client) => {
                const existing = await find(client, sessionId);
                if (!active(existing) || existing.state === 'in_progress') return;
                await client.patch(existing.id, { state: 'in_progress', appendMd: '\n\n已排队：这一轮结束、会话空闲后重启。' });
            });
        },
        /** The queued restart did not happen (failed or dropped): back to the owner. */
        failed(sessionId: string, error: string): Promise<void> {
            return guarded('mark failed', sessionId, async (client) => {
                const existing = await find(client, sessionId);
                if (!active(existing)) return;
                await client.patch(existing.id, { state: 'open', appendMd: `\n\n没有重启成功：${error.slice(0, 300)}` });
            });
        },
        /** Restarted onto new code, caught up, or gone: close the card. */
        settle(sessionId: string, outcome: 'done' | 'superseded', note: string): Promise<void> {
            notified.delete(sessionId);
            return guarded('resolve', sessionId, async (client) => {
                const existing = await find(client, sessionId);
                if (!active(existing)) return;
                await client.resolve(existing.id, { outcome, note: note.slice(0, 2000) });
            });
        },
    };
}
export type StaleWrapperNotices = ReturnType<typeof createStaleWrapperNotices>;
