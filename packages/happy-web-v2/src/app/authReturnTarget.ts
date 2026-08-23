import type { Location } from 'react-router-dom';

type ReturnLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;

const SAFE_PATH = /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/;

/** Keep auth redirects inside this Web app; never accept an absolute URL. */
export function authReturnTarget(state: unknown): string {
  if (!state || typeof state !== 'object' || !('from' in state)) return '/';
  const from = (state as { from?: Partial<ReturnLocation> }).from;
  if (!from || typeof from.pathname !== 'string' || !SAFE_PATH.test(from.pathname)) return '/';
  const search = typeof from.search === 'string' && from.search.startsWith('?') ? from.search : '';
  const hash = typeof from.hash === 'string' && from.hash.startsWith('#') ? from.hash : '';
  if (/[\\\u0000-\u001f\u007f]/.test(search + hash)) return '/';
  return `${from.pathname}${search}${hash}`;
}
