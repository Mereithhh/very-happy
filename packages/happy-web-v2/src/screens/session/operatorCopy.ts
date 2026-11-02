/**
 * B-867: broker error code → user copy. The code is the only thing an error
 * carries (no params, no server text), so the mapping is total and pure.
 */
import type { useTranslation } from '@/i18n/useTranslation';
import { OperatorRpcError } from '@/sync/operatorProtocol';

type T = ReturnType<typeof useTranslation>['t'];

export function operatorErrorCode(error: unknown): string {
    if (error instanceof OperatorRpcError) return error.code;
    return 'rpc_failed';
}

export function operatorErrorCopy(t: T, code: string): string {
    switch (code) {
        case 'cli_upgrade_required':
        case 'machine_unsupported': return t('share.operator.errors.upgrade');
        case 'machine_offline': return t('share.operator.errors.offline');
        case 'operator_method_denied':
        case 'operator_terminal_denied': return t('share.operator.errors.denied');
        case 'operator_mode_escalation': return t('share.operator.errors.modeEscalation');
        case 'operator_path_denied': return t('share.operator.errors.pathDenied');
        case 'operator_terminal_limit': return t('share.operator.errors.terminalLimit');
        case 'not_operator': return t('share.operator.errors.notOperator');
        case 'rate_limited': return t('share.operator.errors.rateLimited');
        case 'server_too_old': return t('share.operator.errors.serverTooOld');
        default: return t('share.operator.errors.generic', { error: code });
    }
}
