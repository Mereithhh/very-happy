/**
 * B-980 model-answer feedback — REST client + a small per-tab store
 * (`specs/2026-11-model-feedback.md`). The instance config says whether the
 * operator turned the feature on; ratings are loaded per session so the
 * buttons show what was chosen on any device.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getHappyClientId } from './apiSocket';
import { getServerUrl } from './serverConfig';

export class ModelFeedbackApiError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
    }
}

// Lenient on purpose: an unknown scope or a missing section reads as "off", never a crash.
const InstanceConfigSchema = z.object({
    modelFeedback: z.object({ enabled: z.boolean(), scope: z.enum(['tagged', 'all']).catch('tagged') }).nullable().optional().catch(null),
    modelFeedbackAdmin: z.boolean().optional().catch(false),
});
export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;

const RatingSchema = z.enum(['up', 'down']);
export type ModelFeedbackRating = z.infer<typeof RatingSchema>;
const ViewSchema = z.object({ id: z.string(), sessionId: z.string(), turnId: z.string(), rating: RatingSchema, comment: z.string().nullable(), updatedAt: z.number() });
export type ModelFeedbackView = z.infer<typeof ViewSchema>;

export type ModelFeedbackSubmit = {
    sessionId: string;
    turnId: string;
    rating: ModelFeedbackRating;
    comment?: string;
    requestIds: string[];
    model?: string | null;
    reportedModel?: string | null;
    agent?: string | null;
    accountProfile?: { id: string; label?: string; kind?: string } | null;
    messageSeq?: number | null;
    answeredAt?: number | null;
};

async function request(path: string, init?: RequestInit): Promise<Response> {
    const credentials = getCurrentAuth()?.credentials;
    if (!credentials) throw new ModelFeedbackApiError('unauthorized', 401);
    const response = await fetch(`${getServerUrl()}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId(), ...init?.headers },
    });
    assertNotAuthFailure(response, 'apiModelFeedback');
    if (!response.ok) {
        let code = `http_${response.status}`;
        try {
            const body = await response.json() as { error?: unknown };
            if (typeof body.error === 'string') code = body.error;
        } catch { /* non-JSON error body */ }
        throw new ModelFeedbackApiError(code, response.status);
    }
    return response;
}

async function call<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    return schema.parse(await (await request(path, init)).json());
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Older servers (404) and failures read as "feature off". */
export async function fetchInstanceConfig(): Promise<InstanceConfig> {
    try {
        return await call('/v1/instance/config', InstanceConfigSchema);
    } catch {
        return { modelFeedback: null, modelFeedbackAdmin: false };
    }
}

export function putModelFeedback(input: ModelFeedbackSubmit): Promise<{ feedback: ModelFeedbackView }> {
    return call('/v1/model-feedback', z.object({ feedback: ViewSchema }), json('PUT', input));
}

export async function deleteModelFeedback(sessionId: string, turnId: string): Promise<void> {
    await request(`/v1/model-feedback?sessionId=${encodeURIComponent(sessionId)}&turnId=${encodeURIComponent(turnId)}`, { method: 'DELETE' });
}

export function listSessionModelFeedback(sessionId: string): Promise<{ items: ModelFeedbackView[] }> {
    return call(`/v1/model-feedback?sessionId=${encodeURIComponent(sessionId)}`, z.object({ items: z.array(ViewSchema) }));
}

/** Admin export as a file download (the token rides in the header, so a plain link cannot do it). */
export async function downloadModelFeedbackExport(format: 'jsonl' | 'csv', query: { since?: number } = {}): Promise<number> {
    const params = new URLSearchParams({ format });
    if (query.since) params.set('since', String(query.since));
    const response = await request(`/v1/model-feedback/export?${params}`);
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `model-feedback.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return blob.size;
}

// ---------------------------------------------------------------- store

type State = {
    config: InstanceConfig | null;
    /** sessionId → turnId → rating view */
    ratings: Map<string, Map<string, ModelFeedbackView>>;
};

let state: State = { config: null, ratings: new Map() };
const listeners = new Set<() => void>();
let configLoadedAt = 0;
let configLoading: Promise<void> | null = null;
const sessionsLoading = new Set<string>();
const CONFIG_TTL_MS = 10 * 60_000;

function emit(next: State) {
    state = next;
    for (const l of listeners) l();
}
function subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
}

function ensureConfig(now = Date.now()): void {
    if (configLoading || (state.config && now - configLoadedAt < CONFIG_TTL_MS)) return;
    configLoading = fetchInstanceConfig().then(config => {
        configLoadedAt = Date.now();
        emit({ ...state, config });
    }).finally(() => { configLoading = null; });
}

export function useInstanceConfig(): InstanceConfig | null {
    useEffect(() => ensureConfig(), []);
    return useSyncExternalStore(subscribe, () => state.config, () => null);
}

function setRating(sessionId: string, turnId: string, view: ModelFeedbackView | null) {
    const ratings = new Map(state.ratings);
    const forSession = new Map(ratings.get(sessionId) ?? []);
    if (view) forSession.set(turnId, view); else forSession.delete(turnId);
    ratings.set(sessionId, forSession);
    emit({ ...state, ratings });
}

/** The caller's rating of one turn (`undefined` while the session's ratings load). */
export function useModelFeedbackRating(sessionId: string, turnId: string | undefined, enabled: boolean): ModelFeedbackView | null | undefined {
    useEffect(() => {
        if (!enabled || state.ratings.has(sessionId) || sessionsLoading.has(sessionId)) return;
        sessionsLoading.add(sessionId);
        listSessionModelFeedback(sessionId)
            .then(({ items }) => {
                const ratings = new Map(state.ratings);
                ratings.set(sessionId, new Map(items.map(v => [v.turnId, v])));
                emit({ ...state, ratings });
            })
            .catch(() => {
                const ratings = new Map(state.ratings);
                ratings.set(sessionId, new Map());
                emit({ ...state, ratings });
            })
            .finally(() => sessionsLoading.delete(sessionId));
    }, [sessionId, enabled]);
    return useSyncExternalStore(subscribe, () => {
        const forSession = state.ratings.get(sessionId);
        if (!forSession) return undefined;
        return turnId ? forSession.get(turnId) ?? null : null;
    }, () => undefined);
}

export async function rateModelAnswer(input: ModelFeedbackSubmit): Promise<ModelFeedbackView> {
    const { feedback } = await putModelFeedback(input);
    setRating(input.sessionId, input.turnId, feedback);
    return feedback;
}

export async function clearModelAnswerRating(sessionId: string, turnId: string): Promise<void> {
    await deleteModelFeedback(sessionId, turnId);
    setRating(sessionId, turnId, null);
}

/** Test hook. */
export function resetModelFeedbackStore(): void {
    state = { config: null, ratings: new Map() };
    configLoadedAt = 0;
    configLoading = null;
    sessionsLoading.clear();
}
