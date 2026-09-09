/** Account-owned Todos. KV supplies CAS and tombstones; clocks never settle conflicts. */
import type { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export const BUILTIN_TODO_PREFIX = 'vh.todo.v1.';
export const TITLE_MAX_LENGTH = 500;
export const NOTE_MAX_LENGTH = 8_000;
export const MAX_COUNT = 500;
const LIST_LIMIT = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BuiltinTodo {
    schemaVersion: 1;
    id: string;
    title: string;
    note: string;
    status: 'open' | 'done';
    order: number;
    createdAt: number;
    updatedAt: number;
}
export interface BuiltinTodoRecord extends BuiltinTodo { version: number }
export type BuiltinTodoPatch = Partial<Pick<BuiltinTodo, 'title' | 'note' | 'status'>>;
export interface BuiltinTodoList { records: BuiltinTodoRecord[]; truncated: boolean; invalidCount: number }
export type BuiltinTodoErrorCode = 'conflict' | 'validation' | 'limit' | 'network' | 'timeout' | 'http' | 'invalid-response' | 'order-collision';
export class BuiltinTodoError extends Error {
    constructor(public readonly code: BuiltinTodoErrorCode, message: string, public readonly httpStatus?: number) {
        super(message);
        this.name = 'BuiltinTodoError';
    }
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Invalid/unknown records stay untouched on the server, never coerced into v1. */
export function parseBuiltinTodo(raw: unknown, key?: string): BuiltinTodo | null {
    if (!object(raw) || raw.schemaVersion !== 1 || typeof raw.id !== 'string' || !UUID.test(raw.id)) return null;
    if (key !== undefined && key !== BUILTIN_TODO_PREFIX + raw.id) return null;
    if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > TITLE_MAX_LENGTH) return null;
    if (typeof raw.note !== 'string' || raw.note.length > NOTE_MAX_LENGTH) return null;
    if (raw.status !== 'open' && raw.status !== 'done') return null;
    if (typeof raw.order !== 'number' || !Number.isFinite(raw.order) || Math.abs(raw.order) > Number.MAX_SAFE_INTEGER) return null;
    if (!stamp(raw.createdAt) || !stamp(raw.updatedAt)) return null;
    return {
        schemaVersion: 1, id: raw.id, title: raw.title, note: raw.note, status: raw.status,
        order: raw.order, createdAt: raw.createdAt, updatedAt: raw.updatedAt,
    };
}

export function encodeBuiltinTodo(todo: BuiltinTodo): string {
    const parsed = parseBuiltinTodo(todo);
    if (!parsed) throw new BuiltinTodoError('validation', 'Invalid Todo');
    const bytes = new TextEncoder().encode(JSON.stringify(parsed));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function decodeBuiltinTodo(value: string, key?: string): BuiltinTodo | null {
    try {
        const binary = atob(value);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return parseBuiltinTodo(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), key);
    } catch { return null; }
}

export function sortBuiltinTodos<T extends BuiltinTodo>(records: readonly T[]): T[] {
    return [...records].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

interface Mutation { key: string; value: string | null; version: number }
export interface BuiltinTodoClientOptions {
    serverUrl?: string;
    clientId?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

/**
 * No retry, offline queue, or global state: a failed write may have committed.
 * Callers refresh to reconcile and preserve their draft until success. A client
 * captures its endpoint/token once; account changes must mount a fresh client.
 */
export function createBuiltinTodoClient(credentials: AuthCredentials, options: BuiltinTodoClientOptions = {}) {
    const serverUrl = (options.serverUrl ?? getServerUrl()).replace(/\/$/, '');
    const token = credentials.token;
    const clientId = options.clientId ?? getHappyClientId();
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = options.timeoutMs ?? 15_000;

    async function request(path: string, mutations?: Mutation[], allowNotFound = false): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetcher(serverUrl + path, {
                method: mutations ? 'POST' : 'GET',
                headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': clientId,
                    ...(mutations ? { 'Content-Type': 'application/json' } : {}) },
                ...(mutations ? { body: JSON.stringify({ mutations }) } : {}),
                signal: controller.signal,
            });
            if (allowNotFound && response.status === 404) return undefined;
            if (response.status === 409) throw new BuiltinTodoError('conflict', 'Todo changed on another device; refresh before retrying', 409);
            if (!response.ok) throw new BuiltinTodoError('http', `Todo request failed (${response.status})`, response.status);
            try { return await response.json(); }
            catch (error) {
                if (controller.signal.aborted) throw error;
                throw new BuiltinTodoError('invalid-response', 'Invalid Todo server response');
            }
        } catch (error) {
            if (controller.signal.aborted) throw new BuiltinTodoError('timeout', 'Todo request timed out; refresh to confirm the result');
            if (error instanceof BuiltinTodoError) throw error;
            throw new BuiltinTodoError('network', 'Todo request failed; refresh to confirm the result');
        } finally { clearTimeout(timer); }
    }

    async function list(): Promise<BuiltinTodoList> {
        const body = await request(`/v1/kv?prefix=${encodeURIComponent(BUILTIN_TODO_PREFIX)}&limit=${LIST_LIMIT}`);
        if (!object(body) || !Array.isArray(body.items)) throw new BuiltinTodoError('invalid-response', 'Invalid Todo list response');
        const records: BuiltinTodoRecord[] = [];
        const seen = new Set<string>();
        let invalidCount = 0;
        for (const item of body.items) {
            if (!object(item) || typeof item.key !== 'string' || typeof item.value !== 'string'
                || !Number.isSafeInteger(item.version) || (item.version as number) < 0) { invalidCount++; continue; }
            const todo = decodeBuiltinTodo(item.value, item.key);
            if (!todo || seen.has(todo.id)) { invalidCount++; continue; }
            seen.add(todo.id);
            records.push({ ...todo, version: item.version as number });
        }
        return { records: sortBuiltinTodos(records), truncated: body.items.length >= LIST_LIMIT, invalidCount };
    }

    async function mutate(mutations: Mutation[]): Promise<number[]> {
        const body = await request('/v1/kv', mutations);
        if (!object(body) || body.success !== true || !Array.isArray(body.results) || body.results.length !== mutations.length) {
            throw new BuiltinTodoError('invalid-response', 'Invalid Todo write response; refresh to confirm the result');
        }
        // Matching keys and exact next versions prevent accepting unrelated or partial acknowledgements.
        return mutations.map((mutation) => {
            const result = (body.results as unknown[]).filter((entry) => object(entry) && entry.key === mutation.key);
            if (result.length !== 1 || !object(result[0]) || result[0].version !== mutation.version + 1) {
                throw new BuiltinTodoError('invalid-response', 'Invalid Todo write acknowledgement; refresh to confirm the result');
            }
            return result[0].version as number;
        });
    }

    function validateRecord(record: BuiltinTodoRecord): void {
        if (!parseBuiltinTodo(record) || !Number.isSafeInteger(record.version) || record.version < 0) {
            throw new BuiltinTodoError('validation', 'Invalid Todo version');
        }
    }
    function mutation(record: BuiltinTodoRecord, next: BuiltinTodo | null): Mutation {
        validateRecord(record);
        return { key: BUILTIN_TODO_PREFIX + record.id, value: next ? encodeBuiltinTodo(next) : null, version: record.version };
    }

    interface PendingCreate { draft: BuiltinTodo; attempted: boolean; operation?: Promise<BuiltinTodoRecord> }
    const pendingCreates = new Map<string, PendingCreate>();

    async function create(title: string, note = ''): Promise<BuiltinTodoRecord> {
        const cleanTitle = title.trim();
        const payloadKey = JSON.stringify([cleanTitle, note]);
        let pending = pendingCreates.get(payloadKey);
        if (pending?.operation) return pending.operation;
        if (!pending) {
            const now = Date.now();
            const draft: BuiltinTodo = {
                schemaVersion: 1, id: crypto.randomUUID(), title: cleanTitle, note, status: 'open',
                order: 0, createdAt: now, updatedAt: now,
            };
            if (!parseBuiltinTodo(draft)) throw new BuiltinTodoError('validation', 'Invalid Todo title or note');
            pending = { draft, attempted: false };
            pendingCreates.set(payloadKey, pending);
        }
        const entry = pending;
        const operation = (async (): Promise<BuiltinTodoRecord> => {
            if (entry.attempted) {
                // A lost acknowledgement must not turn the user's retry into
                // a second task. Confirm the original ID before any new write.
                const key = BUILTIN_TODO_PREFIX + entry.draft.id;
                const existing = await request(`/v1/kv/${encodeURIComponent(key)}`, undefined, true);
                if (existing !== undefined) {
                    const todo = object(existing) && typeof existing.value === 'string'
                        ? decodeBuiltinTodo(existing.value, key) : null;
                    if (!todo || !object(existing) || existing.key !== key
                        || !Number.isSafeInteger(existing.version) || (existing.version as number) < 0) {
                        throw new BuiltinTodoError('invalid-response', 'Cannot confirm the previous Todo creation');
                    }
                    return { ...todo, version: existing.version as number };
                }
            }
            const current = await list();
            if (current.truncated || current.records.length + current.invalidCount >= MAX_COUNT) {
                throw new BuiltinTodoError('limit', 'Todo limit reached');
            }
            // A gap keeps floating-point headroom; randomness avoids ties when
            // independent devices append from the same list snapshot.
            const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
            entry.draft.order = Math.max(0, ...current.records.map((todo) => todo.order)) + 1024 + random;
            const encoded = encodeBuiltinTodo(entry.draft);
            entry.attempted = true;
            const versions = await mutate([{ key: BUILTIN_TODO_PREFIX + entry.draft.id, value: encoded, version: -1 }]);
            return { ...entry.draft, version: versions[0] };
        })();
        entry.operation = operation;
        try {
            const created = await operation;
            pendingCreates.delete(payloadKey);
            return created;
        } catch (error) {
            // Keep only operations that might have reached the server. This is
            // an in-memory idempotency guard, never an automatic retry queue.
            if (!entry.attempted) pendingCreates.delete(payloadKey);
            throw error;
        } finally { entry.operation = undefined; }
    }

    async function update(record: BuiltinTodoRecord, patch: BuiltinTodoPatch): Promise<BuiltinTodoRecord> {
        validateRecord(record);
        const next: BuiltinTodo = { ...record,
            ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
            ...(patch.note !== undefined ? { note: patch.note } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            updatedAt: Date.now(),
        };
        const versions = await mutate([mutation(record, next)]);
        return { ...next, version: versions[0] };
    }

    async function remove(record: BuiltinTodoRecord): Promise<void> {
        await mutate([mutation(record, null)]);
    }

    async function move(record: BuiltinTodoRecord, neighbor: BuiltinTodoRecord): Promise<[BuiltinTodoRecord, BuiltinTodoRecord]> {
        validateRecord(record);
        validateRecord(neighbor);
        if (record.id === neighbor.id) throw new BuiltinTodoError('validation', 'A Todo cannot move past itself');
        let recordOrder = neighbor.order;
        let neighborOrder = record.order;
        if (record.order === neighbor.order) {
            // Rare imported/concurrent ties: inspect surrounding ranks, then
            // prove the two-key adjustment changes only the requested pair.
            const current = await list();
            if (current.truncated || current.invalidCount) throw new BuiltinTodoError('order-collision', 'Cannot safely reorder this incomplete Todo list');
            const records = current.records;
            const a = records.findIndex((todo) => todo.id === record.id);
            const b = records.findIndex((todo) => todo.id === neighbor.id);
            if (a < 0 || b < 0 || records[a].version !== record.version || records[b].version !== neighbor.version || Math.abs(a - b) !== 1) {
                throw new BuiltinTodoError('conflict', 'Todo order changed; refresh before retrying');
            }
            const lo = Math.min(a, b), hi = Math.max(a, b);
            const order = record.order;
            const before = records[lo - 1]?.order ?? order - 1024;
            const after = records[hi + 1]?.order ?? order + 1024;
            const lowOrder = before + (order - before) / 2;
            const highOrder = order + (after - order) / 2;
            if (!Number.isFinite(lowOrder) || !Number.isFinite(highOrder) || lowOrder >= highOrder) {
                throw new BuiltinTodoError('order-collision', 'These Todos share an order that cannot safely be changed');
            }
            recordOrder = a < b ? highOrder : lowOrder;
            neighborOrder = a < b ? lowOrder : highOrder;
            const expected = records.map((todo) => todo.id);
            [expected[a], expected[b]] = [expected[b], expected[a]];
            const actual = sortBuiltinTodos(records.map((todo) => todo.id === record.id ? { ...todo, order: recordOrder }
                : todo.id === neighbor.id ? { ...todo, order: neighborOrder } : todo)).map((todo) => todo.id);
            if (expected.some((id, index) => id !== actual[index])) {
                throw new BuiltinTodoError('order-collision', 'These Todos share an order that cannot safely be changed');
            }
        }
        const updatedAt = Date.now();
        const nextRecord = { ...record, order: recordOrder, updatedAt };
        const nextNeighbor = { ...neighbor, order: neighborOrder, updatedAt };
        const versions = await mutate([mutation(record, nextRecord), mutation(neighbor, nextNeighbor)]);
        return [{ ...nextRecord, version: versions[0] }, { ...nextNeighbor, version: versions[1] }];
    }

    return { list, create, update, remove, move };
}
export type BuiltinTodoClient = ReturnType<typeof createBuiltinTodoClient>;
