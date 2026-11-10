/**
 * B-911 — the 「会话停在旧版本」 card. The daemon posts it (attention item
 * `key: stale-wrapper`, `source: automation`, `kind: todo`) when it classifies
 * a session it can restart but never prove idle by check-in (`manual` /
 * `no-report`, `no-check-in`: team leads, automations, pre-B-852 wrappers).
 * The server pushes it once; this card words it in the reader's language and
 * offers 「本轮结束后重启」: machine RPC `restart-session` with `whenIdle`, which
 * the daemon queues until the session is idle (history and model intent kept).
 *
 * Only a daemon that advertises `daemonState.autoRestart.idleRestart` gets the
 * button — an older one ignores `whenIdle` and would restart at once.
 */
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { AttentionItem } from '@slopus/happy-wire';
import { t } from '@/text';
import { toast } from '@/ui';
import { useMachine, useSession } from '@/sync/storage';
import { machineRestartSession } from '@/sync/ops';
import { useAttentionStore } from '@/sync/attentionStore';

export const STALE_WRAPPER_ITEM_KEY = 'stale-wrapper';

export function isStaleWrapperItem(item: Pick<AttentionItem, 'key' | 'source'>): boolean {
    return item.key === STALE_WRAPPER_ITEM_KEY && item.source === 'automation';
}

/** The daemon queues `restart-session { whenIdle }` (B-911); older daemons would restart at once. */
export function daemonQueuesIdleRestart(daemonState: unknown): boolean {
    const autoRestart = (daemonState as { autoRestart?: { idleRestart?: unknown } } | null | undefined)?.autoRestart;
    return autoRestart?.idleRestart === true;
}

/** The facts the daemon's (Chinese) title carries: 会话「<name>」还在用 CLI <from>，没法自动升级到 <target>. */
export function staleWrapperItemFacts(item: Pick<AttentionItem, 'key' | 'source' | 'title'>): { name: string; from: string; target: string } | null {
    if (!isStaleWrapperItem(item)) return null;
    const match = /^会话「(.+)」还在用 CLI (\S+)，没法自动升级到 (\S+)$/.exec(item.title);
    return match ? { name: match[1], from: match[2], target: match[3] } : null;
}

/** Title and body in the reader's language, or null (not such an item / not parseable → the server's text). */
export function staleWrapperItemText(item: Pick<AttentionItem, 'key' | 'source' | 'title'>): { title: string; body: string; by: string } | null {
    const facts = staleWrapperItemFacts(item);
    if (!facts) return null;
    return { title: t('staleWrapperCard.title', facts), body: t('staleWrapperCard.body', facts), by: t('staleWrapperCard.by') };
}

/** Daemon refusal (`idle-restart:<code>`) → what the owner reads. */
export function staleWrapperRestartError(message: string): string {
    const code = /idle-restart:([a-z-]+)/.exec(message)?.[1];
    if (code === 'not-live') return t('staleWrapperCard.errorNotLive');
    if (code === 'not-resumable') return t('staleWrapperCard.errorNotResumable');
    if (code === 'no-turn-reports') return t('staleWrapperCard.errorNoTurnReports');
    return t('staleWrapperCard.errorGeneric', { reason: code ?? message.slice(0, 80) });
}

type ItemFields = Pick<AttentionItem, 'id' | 'key' | 'source' | 'sessionId' | 'state'> & AttentionItem;

export function StaleWrapperItemActions({ item }: { item: ItemFields }) {
    if (!isStaleWrapperItem(item)) return null;
    return <Actions item={item} />;
}

function Actions({ item }: { item: ItemFields }) {
    const session = useSession(item.sessionId);
    const machineId = session?.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const [busy, setBusy] = useState(false);
    if (item.state === 'in_progress') {
        return <span className="brf-note" data-testid="stale-wrapper-queued">{t('staleWrapperCard.queued')}</span>;
    }
    if (item.state !== 'open' || !machine || !machine.active || !daemonQueuesIdleRestart(machine.daemonState)) return null;
    const restart = async () => {
        setBusy(true);
        try {
            const result = await machineRestartSession({ machineId, sessionId: item.sessionId, whenIdle: true });
            if (result.type === 'success') {
                // The daemon marks the item in_progress itself; show it at once.
                useAttentionStore.getState().apply({ ...item, state: 'in_progress', updatedAt: Date.now() });
                toast.success(t('staleWrapperCard.queuedToast'));
            } else {
                toast.error(staleWrapperRestartError(result.type === 'error' ? result.errorMessage : result.type));
            }
        } finally {
            setBusy(false);
        }
    };
    return (
        <button type="button" data-testid="stale-wrapper-restart" disabled={busy} onClick={() => void restart()}>
            <RotateCcw size={13} aria-hidden />{t('staleWrapperCard.restartWhenIdle')}
        </button>
    );
}
