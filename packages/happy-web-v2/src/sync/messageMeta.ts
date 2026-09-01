import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride, normalizeAgentKey } from './agentDefaults';
import { normalizeClaudeOutboundMode } from './permissionModeOutbound';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const meta: MessageModeMeta = {};
    const isClaude = normalizeAgentKey(session.metadata?.flavor) === 'claude';

    // B-262 A2 (asymmetric): a resolved session value is always sent; when the
    // session has no value, fall back to the synced per-agent override ONLY —
    // never to the code default. The CLI honors meta.permissionMode in BOTH
    // directions on every released version, so sending a guessed
    // `bypassPermissions` would silently switch assistant / review-first /
    // forked sessions nobody chose yolo for. For claude the value is also
    // normalized so a dead selector key (dontAsk) can never make the CLI
    // drop the whole message (its MessageMetaSchema enum would reject it).
    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        const normalized = isClaude ? normalizeClaudeOutboundMode(session.permissionMode) : session.permissionMode;
        if (normalized) meta.permissionMode = normalized as PermissionModeKey;
    } else if (agentOverrides.permissionMode !== undefined) {
        if (isClaude) {
            // Upgrade-only fallback: a synced override of `plan`/`acceptEdits`
            // must not pull a session another device just put in yolo back down.
            const normalized = normalizeClaudeOutboundMode(agentOverrides.permissionMode);
            if (normalized === 'bypassPermissions') meta.permissionMode = normalized;
        } else {
            meta.permissionMode = agentOverrides.permissionMode as PermissionModeKey;
        }
    }

    // B-103: for claude, ALWAYS send model/effort explicitly — `null` means
    // "reset to the machine's own default" on the CLI (both fields already
    // decode null → undefined there, on every released version). Omitting the
    // field instead leaves the CLI's sticky per-session state (or its old
    // hardcoded opus/medium fallbacks) in force, which silently defeated the
    // "default = follow the machine /model" contract in agentDefaults.ts.
    const modelMode = session.modelMode ?? agentOverrides.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    } else if (isClaude) {
        meta.model = null;
    }

    const effort = session.effortLevel ?? agentOverrides.effortLevel;
    if (effort !== undefined) {
        meta.effort = effort;
    } else if (isClaude) {
        meta.effort = null;
    }

    return meta;
}
