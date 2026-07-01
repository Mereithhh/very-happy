import { useEffect, useState } from 'react';

/**
 * Seconds elapsed since `anchorMs` (a wall-clock ms timestamp), ticking every
 * second. Returns 0 when anchor is null. Respects reduced-motion only loosely:
 * the tick is cheap and necessary for a live timer, so we keep it.
 */
export function useElapsedSeconds(anchorMs: number | null | undefined): number {
    const [seconds, setSeconds] = useState(() =>
        anchorMs ? Math.max(0, Math.floor((Date.now() - anchorMs) / 1000)) : 0,
    );

    useEffect(() => {
        if (!anchorMs) {
            setSeconds(0);
            return;
        }
        const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - anchorMs) / 1000)));
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [anchorMs]);

    return anchorMs ? seconds : 0;
}
