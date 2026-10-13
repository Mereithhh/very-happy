/** B-568 ②: see reconnectHint.ts. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import { useSocketStatus } from '@/app/useConnection';
import { isReconnecting, RECONNECT_HINT_DELAY_MS } from './reconnectHint';

export function useReconnectingHint(): boolean {
    const status = useSocketStatus();
    // setSocketStatus('connected') stamps socketLastConnectedAt: the one
    // existing "has this tab ever been connected" fact.
    const everConnected = storage((s) => s.socketLastConnectedAt != null);
    const down = isReconnecting(status, everConnected);
    const [show, setShow] = useState(false);
    useEffect(() => {
        if (!down) {
            setShow(false);
            return;
        }
        const timer = setTimeout(() => setShow(true), RECONNECT_HINT_DELAY_MS);
        return () => clearTimeout(timer);
    }, [down]);
    return down && show;
}
