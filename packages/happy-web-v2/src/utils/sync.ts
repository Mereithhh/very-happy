import { backoff, createBackoff, type BackoffFunc } from "@/utils/time";
import { isAuthLatched } from "@/auth/authLatch";

/**
 * B-490: backoff() rethrows auth failures (401/403, or anything after the auth
 * latch tripped) instead of retrying forever. A latched account stops the sync
 * for good (no more requests until reload/login); a plain 403 ends THIS round
 * so a later invalidate() may try again.
 */
async function runGuarded(fn: () => Promise<void>, retry: BackoffFunc = backoff): Promise<'ok' | 'stop'> {
    try {
        await retry(fn);
        return 'ok';
    } catch (e) {
        if (isAuthLatched()) return 'stop';
        console.warn('[sync] giving up this round', (e as Error)?.message ?? e);
        return 'ok';
    }
}

export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _pendings: (() => void)[] = [];
    private _wake: (() => void) | null = null;
    // Same policy as the shared backoff, but its sleep can be cut short by invalidateNow().
    private _backoff = createBackoff({
        onError: (e) => { console.warn(e); },
        sleep: (ms) => new Promise<void>((resolve) => {
            const timer = setTimeout(done, ms);
            function done() {
                clearTimeout(timer);
                resolve();
            }
            this._wake = () => {
                this._wake = null;
                done();
            };
        }),
    });

    constructor(command: () => Promise<void>) {
        this._command = command;
    }

    /**
     * B-513: invalidate AND cut a pending backoff sleep short, so new work
     * (a user send or retry) goes out now instead of after up to 10s of
     * backoff left over from an earlier failure. Only for user-initiated
     * work — a poller must keep plain invalidate() (B-490 storm guard).
     */
    invalidateNow() {
        this.invalidate();
        this._wake?.();
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            if (!this._invalidatedDouble) {
                this._invalidatedDouble = true;
            }
        }
    }

    async invalidateAndAwait() {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.invalidate();
        });
    }

    async awaitQueue() {
        if (this._stopped || (!this._invalidated && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }


    private _doSync = async () => {
        const outcome = await runGuarded(async () => {
            if (this._stopped) {
                return;
            }
            await this._command();
        }, this._backoff);
        this._wake = null;
        if (outcome === 'stop') this.stop();
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}

export class ValueSync<T> {
    private _latestValue: T | undefined;
    private _hasValue = false;
    private _processing = false;
    private _stopped = false;
    private _command: (value: T) => Promise<void>;
    private _pendings: (() => void)[] = [];

    constructor(command: (value: T) => Promise<void>) {
        this._command = command;
    }

    setValue(value: T) {
        if (this._stopped) {
            return;
        }
        this._latestValue = value;
        this._hasValue = true;
        if (!this._processing) {
            this._processing = true;
            this._doSync();
        }
    }

    async setValueAndAwait(value: T) {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.setValue(value);
        });
    }

    async awaitQueue() {
        if (this._stopped || (!this._processing && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }

    private _doSync = async () => {
        while (this._hasValue && !this._stopped) {
            const value = this._latestValue!;
            this._hasValue = false;
            
            const outcome = await runGuarded(async () => {
                if (this._stopped) {
                    return;
                }
                await this._command(value);
            });
            if (outcome === 'stop') this.stop();

            if (this._stopped) {
                this._notifyPendings();
                return;
            }
        }
        
        this._processing = false;
        this._notifyPendings();
    }
}