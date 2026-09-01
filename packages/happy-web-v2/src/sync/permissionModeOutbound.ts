/**
 * Claude 出站权限模式清洗（B-262 A1，纯函数）。
 *
 * 背景：选择器曾提供 `dontAsk`，但所有已发布 CLI 的 `MessageMetaSchema` 枚举里都没有它——
 * 带着它发出的消息在 CLI 侧 `safeParse` 失败，被**静默丢弃整条**。同样的值还可能已经躺在
 * 设备本地的 session-permission-modes 与 synced `agentDefaultOverrides` 里。
 *
 * 规则：合法集 default | acceptEdits | plan | bypassPermissions；`yolo` 视为 bypass 的别名
 * （CLI 也接受）；其余（含 dontAsk）→ `default`——deny→ask 不放大权限，语义不等价但可接受
 * （真正支持 dontAsk/auto 另立 backlog）。
 */
import type { AgentDefaultOverrides } from './agentDefaults';

export const CLAUDE_OUTBOUND_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type ClaudeOutboundMode = typeof CLAUDE_OUTBOUND_MODES[number];

export function isClaudeOutboundMode(value: unknown): value is ClaudeOutboundMode {
    return typeof value === 'string' && (CLAUDE_OUTBOUND_MODES as readonly string[]).includes(value);
}

export function normalizeClaudeOutboundMode(value: string | null | undefined): ClaudeOutboundMode | null {
    if (value === null || value === undefined) return null;
    if (value === 'yolo') return 'bypassPermissions';
    return isClaudeOutboundMode(value) ? value : 'default';
}

/**
 * Synced override 清洗：返回需要写回的**完整** `agentDefaultOverrides` 对象（铁律 1：
 * delta 必须整对象、只在值真变时写一次），无需改动时返回 null。只碰 claude。
 */
export function sanitizeAgentDefaultOverrides(
    overrides: AgentDefaultOverrides | null | undefined,
): AgentDefaultOverrides | null {
    const claude = overrides?.claude;
    const mode = claude?.permissionMode;
    if (mode === undefined) return null;
    const normalized = normalizeClaudeOutboundMode(mode);
    if (normalized === mode) return null;
    return { ...(overrides ?? {}), claude: { ...claude, permissionMode: normalized ?? undefined } };
}

/**
 * 设备本地 session→mode 表清洗。非法值删条目（本地表不持久化 `default`，删掉后该会话
 * 回到「未确认」显示，而不是继续显示一个 CLI 不认识的模式）。无改动返回同一引用。
 */
export function sanitizeSessionPermissionModes(
    modes: Readonly<Record<string, string>>,
): Record<string, string> {
    let changed = false;
    const next: Record<string, string> = {};
    for (const [id, mode] of Object.entries(modes)) {
        // Codex/Gemini vocab lives in the same map; only rewrite values that are
        // unmistakably the dead Claude option.
        if (mode === 'dontAsk') { changed = true; continue; }
        next[id] = mode;
    }
    return changed ? next : (modes as Record<string, string>);
}
