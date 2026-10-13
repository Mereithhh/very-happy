/**
 * B-599: device-local switch for the in-app layout overlay. Persisted because
 * a home-screen app can't keep a `?vhdiag=1` query across in-app navigation —
 * turn it on from /diag/viewport, then open a session.
 */
import { parseVhDiagParam } from './viewportReport';

const KEY = 'vh.vhdiag';
const EVENT = 'vh:vhdiag-change';

export function readVhDiagFlag(): boolean {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch {
        return false;
    }
}

function writeFlag(on: boolean): void {
    try {
        if (on) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
    } catch { /* private mode: overlay just won't persist */ }
}

export function setVhDiagFlag(on: boolean): void {
    writeFlag(on);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

/** Applies `?vhdiag=1|0` from the boot URL (no event: called during the
 *  gate's first render), then returns the effective flag. */
export function initVhDiagFlagFromUrl(search: string): boolean {
    const fromUrl = parseVhDiagParam(search);
    if (fromUrl !== null) {
        writeFlag(fromUrl);
        return fromUrl;
    }
    return readVhDiagFlag();
}

export function subscribeVhDiagFlag(fn: (on: boolean) => void): () => void {
    const onChange = (e: Event) => fn(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
}
