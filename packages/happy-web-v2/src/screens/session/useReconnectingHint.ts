/** B-568 ②: see reconnectHint.ts. */
import { useEffect, useState } from 'react';
import { useSocketStatus } from '@/app/useConnection';
import { isSocketDown, RECONNECT_HINT_DELAY_MS } from './reconnectHint';

export function useReconnectingHint(): boolean {
    const status = useSocketStatus();
    const down = isSocketDown(status);
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
