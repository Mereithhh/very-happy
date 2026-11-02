/**
 * B-867 operator activity log rows (owner side): label key per event kind and one
 * short detail. Pure, so it is unit tested without the dialog (operatorEvents.test.ts).
 */
import type { SimpleTranslationKey } from '@/text';
import type { OperatorEvent } from '@/sync/sessionShareTypes';

const EVENT_LABEL: Record<string, SimpleTranslationKey> = {
    'grant.operator': 'share.operator.event.grantOperator',
    'grant.operator.removed': 'share.operator.event.grantOperatorRemoved',
    'terminal.open': 'share.operator.event.terminalOpen',
    'terminal.attach': 'share.operator.event.terminalAttach',
    'terminal.close': 'share.operator.event.terminalClose',
    'terminal.kill': 'share.operator.event.terminalKill',
    'terminal.input': 'share.operator.event.terminalInput',
    permission: 'share.operator.event.permission',
    abort: 'share.operator.event.abort',
    steer: 'share.operator.event.steer',
    mode: 'share.operator.event.mode',
    model: 'share.operator.event.model',
    btw: 'share.operator.event.btw',
    'file.write': 'share.operator.event.fileWrite',
    'file.upload': 'share.operator.event.fileUpload',
    bash: 'share.operator.event.bash',
    ended: 'share.operator.event.ended',
    'terminal.gone': 'share.operator.event.terminalGone',
};

const END_REASON_LABEL: Record<string, SimpleTranslationKey> = {
    revoked: 'share.operator.endReason.revoked',
    downgraded: 'share.operator.endReason.downgraded',
    ended_by_owner: 'share.operator.endReason.ended_by_owner',
    expired: 'share.operator.endReason.expired',
    archived: 'share.operator.endReason.archived',
    deleted: 'share.operator.endReason.deleted',
};

/** Translation key for an `ended` event's reason, or null for an unknown one (shown raw). */
export function operatorEndReasonKey(reason: unknown): SimpleTranslationKey | null {
    return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(END_REASON_LABEL, reason) ? END_REASON_LABEL[reason] : null;
}

export function operatorEventLabelKey(kind: string): SimpleTranslationKey {
    return EVENT_LABEL[kind] ?? 'share.operator.event.other';
}

/**
 * One short detail per event: a path, a tool, a mode, a translated end reason —
 * and for a file-panel bash the command itself (the owner's audit; the server
 * keeps it out of the external business audit). Never terminal input. Pure.
 */
export function eventDetail(event: OperatorEvent, t: (key: SimpleTranslationKey) => string): string | null {
    const d = event.detail ?? {};
    const reasonKey = event.kind === 'ended' ? operatorEndReasonKey(d.reason) : null;
    if (reasonKey) return t(reasonKey);
    const keys = event.kind === 'bash' ? ['command', 'path'] as const : ['path', 'tool', 'mode', 'model', 'reason', 'decision'] as const;
    for (const key of keys) {
        const v = d[key];
        if (typeof v === 'string' && v) return v.length > 80 ? `${v.slice(0, 77)}…` : v;
    }
    return null;
}
