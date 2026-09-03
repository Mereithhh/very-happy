/**
 * Session role for role-aware rendering (B-353, specs/2026-09-supervisor-session-cards.md §B).
 *
 * - `supervisor`: metadata.tags carries `supervisor` (vh-supervisor standing meta session).
 * - `pi`: ACP-flavoured session in which at least one tool call carried `piTool`
 *   (only a pi-aware CLI sets it; old CLIs leave the session `default`).
 * - `default`: everything else — today's rendering.
 */
export type SessionRole = 'supervisor' | 'pi' | 'default';

export type SessionRoleMetadata = {
    tags?: string[] | null;
    flavor?: string | null;
} | null | undefined;

export type SessionRoleToolCall = { input?: unknown };

export function sessionRoleOf(metadata: SessionRoleMetadata, toolCalls: readonly SessionRoleToolCall[] = []): SessionRole {
    if (Array.isArray(metadata?.tags) && metadata.tags.includes('supervisor')) return 'supervisor';
    if (metadata?.flavor === 'acp' && toolCalls.some((tool) => hasPiTool(tool.input))) return 'pi';
    return 'default';
}

function hasPiTool(input: unknown): boolean {
    return typeof input === 'object' && input !== null && typeof (input as { piTool?: unknown }).piTool === 'string';
}
