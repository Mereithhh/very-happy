/**
 * B-563: the pending-request dock above the composer. Pure folding rules plus a
 * tiny per-session store so the transcript pointer can open the dock.
 *
 * Folding is remembered as the SET of request ids the user folded: a request
 * that arrives later re-opens the dock (it is new work the user has not seen),
 * while answering one of the folded requests keeps the rest folded.
 * (Idea from Orca's prompt-presentation hook, MIT; rewritten for request sets.)
 */
import { useSyncExternalStore } from 'react';

export function isDockCollapsed(collapsedIds: readonly string[] | null | undefined, currentIds: readonly string[]): boolean {
    if (!collapsedIds || currentIds.length === 0) return false;
    return currentIds.every((id) => collapsedIds.includes(id));
}

type RequestLike = { tool?: unknown; arguments?: unknown; kind?: unknown };

function firstLine(value: string): string {
    return value.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** One-line summary for the folded dock: tool name plus what it acts on. */
export function requestSummary(request: RequestLike): string {
    const tool = typeof request.tool === 'string' ? request.tool : '';
    const args = request.arguments && typeof request.arguments === 'object'
        ? request.arguments as Record<string, unknown>
        : null;
    let detail = '';
    if (args) {
        const questions = Array.isArray(args.questions) ? args.questions : null;
        const firstQuestion = questions?.[0] as { question?: unknown } | undefined;
        if (typeof args.command === 'string') detail = args.command;
        else if (typeof args.file_path === 'string') detail = args.file_path;
        else if (typeof firstQuestion?.question === 'string') detail = firstQuestion.question;
        else if (typeof args.plan === 'string') detail = args.plan;
        else if (typeof args.message === 'string') detail = args.message;
    }
    const line = firstLine(detail);
    return line ? `${tool} · ${line}` : tool;
}

// ── per-session folded set (module memory; never persisted) ──────────────────
const folded = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function collapsePermissionDock(sessionId: string, ids: readonly string[]): void {
    folded.set(sessionId, [...ids]);
    emit();
}

export function expandPermissionDock(sessionId: string): void {
    if (!folded.has(sessionId)) return;
    folded.delete(sessionId);
    emit();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function usePermissionDockFolded(sessionId: string): readonly string[] | null {
    return useSyncExternalStore(subscribe, () => folded.get(sessionId) ?? null, () => null);
}

export function permissionDockDomId(sessionId: string): string {
    return `perm-dock-${sessionId}`;
}
