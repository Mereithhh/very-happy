/**
 * B-854 / AGENTS 7 — how an ACP runner leaves, by why it leaves:
 *   - the user's kill / archive → `archive`, its messages `aborted`;
 *   - SIGTERM / SIGINT (daemon stop, upgrade, shutdown) → `offline`, `restarted`;
 *   - a backend that stopped before its first session → `offline`, `failed`.
 * A runner that ended without any of these (null) also goes offline: only a
 * user's intent archives (the runner used to archive on every exit).
 */
import type { QueueDiscardReason } from '@/utils/MessageQueue2';

export type AcpExit = { intent: 'archive' | 'offline'; reason: QueueDiscardReason };

export function acpExitIntent(exit: AcpExit | null): AcpExit['intent'] {
    return exit?.intent ?? 'offline';
}
