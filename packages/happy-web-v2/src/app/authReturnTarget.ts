import type { Location } from 'react-router-dom';

type ReturnLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;

const SAFE_PATH = /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/;
const PERSISTED_RETURN_TARGET_KEY = 'very-happy:auth-return-target';

function safeStateTarget(state: unknown): string | null {
  if (!state || typeof state !== 'object' || !('from' in state)) return null;
  const from = (state as { from?: Partial<ReturnLocation> }).from;
  if (!from || typeof from.pathname !== 'string' || !SAFE_PATH.test(from.pathname)) return null;
  const search = typeof from.search === 'string' && from.search.startsWith('?') ? from.search : '';
  const hash = typeof from.hash === 'string' && from.hash.startsWith('#') ? from.hash : '';
  if (/[\\\u0000-\u001f\u007f]/.test(search + hash)) return null;
  return `${from.pathname}${search}${hash}`;
}

/** Preserve an in-app reauthentication destination across logout's hard reload. */
export function persistAuthReturnTarget(from: ReturnLocation): boolean {
  const target = safeStateTarget({ from });
  if (!target || target === '/' || typeof sessionStorage === 'undefined') return false;
  sessionStorage.setItem(PERSISTED_RETURN_TARGET_KEY, target);
  return true;
}

export function peekPersistedAuthReturnTarget(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const target = sessionStorage.getItem(PERSISTED_RETURN_TARGET_KEY);
  return target && SAFE_PATH.test(target) ? target : null;
}

/** Keep auth redirects inside this Web app; never accept an absolute URL. */
export function authReturnTarget(state: unknown): string {
  const explicit = safeStateTarget(state);
  if (explicit) {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(PERSISTED_RETURN_TARGET_KEY);
    return explicit;
  }
  if (typeof sessionStorage === 'undefined') return '/';
  const persisted = peekPersistedAuthReturnTarget();
  sessionStorage.removeItem(PERSISTED_RETURN_TARGET_KEY);
  return persisted && SAFE_PATH.test(persisted) ? persisted : '/';
}
