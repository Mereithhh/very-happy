/**
 * B-813 (spec B-807 §5.4): the few IndexedDB primitives the message cache
 * needs, as promises with deadlines. Native IDB on purpose — `idb-keyval`
 * has one key-value store, no key ranges and no indexes.
 *
 * Every call takes the factory explicitly so tests run on fake-indexeddb.
 */

/** A cache operation that did not settle in time — the caller turns the cache off. */
export class IdbTimeoutError extends Error {
    constructor(what: string, ms: number) {
        super(`IndexedDB ${what} did not settle within ${ms}ms`);
        this.name = 'IdbTimeoutError';
    }
}

/** `open` / `deleteDatabase` stayed `blocked` (another tab holds an old version). */
export class IdbBlockedError extends Error {
    constructor(what: string, ms: number) {
        super(`IndexedDB ${what} blocked for ${ms}ms`);
        this.name = 'IdbBlockedError';
    }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new IdbTimeoutError(what, ms)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

/** Resolves when the transaction commits; rejects with its error when it aborts. */
export function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
        tx.onerror = (event) => {
            // The abort that follows carries the same error; keep it from
            // bubbling to the database's onerror as an unhandled one.
            event.preventDefault?.();
        };
    });
}

export type Upgrade = (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void;

export function openDatabase(
    factory: IDBFactory,
    name: string,
    version: number,
    upgrade: Upgrade,
    blockedMs: number,
): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
        let settled = false;
        let blockedTimer: ReturnType<typeof setTimeout> | null = null;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (blockedTimer) clearTimeout(blockedTimer);
            fn();
        };
        let request: IDBOpenDBRequest;
        try {
            request = factory.open(name, version);
        } catch (error) {
            reject(error);
            return;
        }
        request.onupgradeneeded = (event) => {
            try {
                upgrade(request.result, request.transaction!, event.oldVersion);
            } catch (error) {
                request.transaction?.abort();
                settle(() => reject(error));
            }
        };
        request.onblocked = () => {
            blockedTimer ??= setTimeout(() => settle(() => reject(new IdbBlockedError(`open ${name}`, blockedMs))), blockedMs);
        };
        request.onsuccess = () => {
            const db = request.result;
            // Another tab deleting or upgrading this database must not wait on us.
            db.onversionchange = () => db.close();
            if (settled) { db.close(); return; }
            settle(() => resolve(db));
        };
        request.onerror = () => settle(() => reject(request.error ?? new Error(`open ${name} failed`)));
    });
}

export function deleteDatabase(factory: IDBFactory, name: string, blockedMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let blockedTimer: ReturnType<typeof setTimeout> | null = null;
        let request: IDBOpenDBRequest;
        try {
            request = factory.deleteDatabase(name);
        } catch (error) {
            reject(error);
            return;
        }
        request.onsuccess = () => { if (blockedTimer) clearTimeout(blockedTimer); resolve(); };
        request.onerror = () => { if (blockedTimer) clearTimeout(blockedTimer); reject(request.error ?? new Error(`delete ${name} failed`)); };
        request.onblocked = () => {
            blockedTimer ??= setTimeout(() => reject(new IdbBlockedError(`delete ${name}`, blockedMs)), blockedMs);
        };
    });
}

export function isQuotaError(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'QuotaExceededError';
}
