import { useEffect, useState } from 'react';

/** design-language §6: visible loading waits ~200ms so fast paths show nothing. */
export const VISIBLE_LOADING_DELAY_MS = 200;

/** `true` only once `flag` has stayed true for `ms`; drops back immediately. */
export function useDelayedFlag(flag: boolean, ms = VISIBLE_LOADING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [flag, ms]);
  return flag && shown;
}
