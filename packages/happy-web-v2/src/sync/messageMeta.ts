import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride, normalizeAgentKey } from './agentDefaults';
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

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = agentOverrides.permissionMode;
    }

    // B-103: for claude, ALWAYS send model/effort explicitly — `null` means
    // "reset to the machine's own default" on the CLI (both fields already
    // decode null → undefined there, on every released version). Omitting the
    // field instead leaves the CLI's sticky per-session state (or its old
    // hardcoded opus/medium fallbacks) in force, which silently defeated the
    // "default = follow the machine /model" contract in agentDefaults.ts.
    const isClaude = normalizeAgentKey(session.metadata?.flavor) === 'claude';

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
