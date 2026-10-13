/**
 * recoverableBoundaryModel — pure decisions for RecoverableBoundary (B-565).
 *
 * Approach adapted from Orca's RecoverableRenderErrorBoundary (MIT,
 * src/renderer/src/components/error-boundaries/RecoverableRenderErrorBoundary.tsx):
 * resetKey-driven auto reset + lazy-chunk errors are not "contained".
 */
import { isChunkLoadError } from '@/app/chunkRecovery';

/** cap for the "copy error" payload — a pathological stack must not flood the clipboard */
export const BOUNDARY_COPY_MAX = 4_000;

/**
 * A missing lazy chunk cannot be fixed by re-rendering the same subtree: the
 * whole page needs the existing ChunkFailure recovery (fetch latest entry,
 * reload). Such errors are rethrown past the local boundary to the route's
 * errorElement.
 */
export function shouldRethrowToRoute(error: unknown): boolean {
    return isChunkLoadError(error);
}

/** Text placed on the clipboard by the fallback's "copy error" action. */
export function boundaryErrorText(region: string, error: unknown, componentStack?: string | null): string {
    const head = error instanceof Error
        ? `${error.name}: ${error.message}`
        : `Error: ${String(error)}`;
    const stack = error instanceof Error && error.stack ? error.stack : '';
    const parts = [`[boundary:${region}] ${head}`];
    if (stack) parts.push(stack);
    if (componentStack) parts.push(`Component stack:${componentStack}`);
    const text = parts.join('\n');
    return text.length > BOUNDARY_COPY_MAX ? `${text.slice(0, BOUNDARY_COPY_MAX)}\n…(truncated)` : text;
}

/** getDerivedStateFromProps rule: a changed resetKey clears a caught error. */
export function nextBoundaryState<K>(
    state: { error: unknown; resetKey: K },
    resetKey: K,
): { error: unknown; resetKey: K } | null {
    if (Object.is(state.resetKey, resetKey)) return null;
    return { error: null, resetKey };
}
