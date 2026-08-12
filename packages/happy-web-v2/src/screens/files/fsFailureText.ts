/**
 * Map an fs RPC failure to a translated, human-readable message. The
 * 'unsupported' code covers BOTH an old daemon (fs RPCs not registered) and
 * an offline machine — the relay answers identically for the two — so the
 * message names both causes instead of guessing.
 */
import type { FsFailure } from '@/sync/fsOps';
import { t as translate } from '@/text';

export function fsFailureText(t: typeof translate, failure: FsFailure): string {
    switch (failure.code) {
        case 'unsupported':
            return t('fsBrowser.unsupported');
        case 'not-found':
            return t('fsBrowser.notFound');
        case 'permission-denied':
            return t('fsBrowser.permissionDenied');
        case 'not-a-directory':
        case 'not-a-file':
        case 'invalid-path':
        case 'unknown':
        default:
            return `${t('fsBrowser.loadFailed')}: ${failure.error}`;
    }
}
