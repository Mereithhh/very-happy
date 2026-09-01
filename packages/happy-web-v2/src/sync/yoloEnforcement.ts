/**
 * Web 侧 yolo 执法决策（B-262 A3，纯函数）。
 *
 * 为什么在 Web：会话的 CLI wrapper 进程在 daemon 升级后仍是旧代码（铁律 7），
 * ≤0.2.88 没有 `set-permission-mode`、0.2.89 只在 working 时接受；这些进程停在
 * `default` 就会让 Bash 必问。Owner 明确批准「前端代点 approve」作为兜底。
 *
 * 只对**明确的意图**执法（本设备选择 / synced override / CLI 已上报），绝不对
 * 代码默认的猜测执法——assistant 会话、多设备 review-first、fork 都可能显示
 * codeDefault 的 yolo 而实际没人选过。
 *
 * 版本事实（对抗 review 核过）：`requests[].kind` 自 0.2.79 才写（缺省视为普通
 * 工具）；`permission` RPC 自 0.2.55 幂等；`claude-live-permission-v1` 自 0.2.89，
 * v2 自 0.2.90；普通工具 allow 带 mode 在 0.2.79–0.2.90 会嵌套 SDK control
 * request、失败即 deny → 裸 allow 不带 mode。
 */

import { getAgentDefaultOverride, getCodeAgentDefaults, type AgentDefaultOverrides } from './agentDefaults';

export type YoloEnforcementDecision = { sessionId: string; requestId: string; tool: string; action: Exclude<YoloEnforcementAction, 'skip'> };

export type IntentSource = 'published' | 'local' | 'override' | 'codeDefault';

export type YoloEnforcementInput = {
    flavor: string | null | undefined;
    variant: string | null | undefined;
    controlledByUser: boolean | null | undefined;
    presence: 'online' | number | null | undefined;
    /** 选择器显示值（session.permissionMode ?? override ?? codeDefault）。 */
    displayed: string | null | undefined;
    intentSource: IntentSource;
    capabilities: readonly string[] | null | undefined;
    busy: boolean;
    request: { tool: string; kind?: string | null };
};

export type YoloEnforcementAction = 'rpc' | 'allow' | 'skip';

const NEVER_AUTO_APPROVE = new Set(['AskUserQuestion', 'ExitPlanMode']);

export function resolveIntentSource(input: {
    published: string | null | undefined;
    local: string | null | undefined;
    override: string | undefined;
}): IntentSource {
    if (input.published != null) return 'published';
    if (input.local != null) return 'local';
    if (input.override !== undefined) return 'override';
    return 'codeDefault';
}

export function isClaudeRemoteSession(input: Pick<YoloEnforcementInput, 'flavor' | 'controlledByUser'>): boolean {
    const flavor = input.flavor;
    if (flavor && flavor !== 'claude') return false; // codex / gemini / openclaw / terminal-mirror
    return input.controlledByUser === false;
}

export function decideYoloEnforcement(input: YoloEnforcementInput): YoloEnforcementAction {
    if (!isClaudeRemoteSession(input)) return 'skip';
    if (input.presence !== 'online') return 'skip';
    if (input.busy) return 'skip';
    if (input.displayed !== 'bypassPermissions' && input.displayed !== 'yolo') return 'skip';
    if (input.intentSource === 'codeDefault') return 'skip';
    if (input.variant === 'assistant' && input.intentSource !== 'local') return 'skip';
    const kind = input.request.kind;
    if (kind != null && kind !== 'tool') return 'skip';
    if (NEVER_AUTO_APPROVE.has(input.request.tool)) return 'skip';
    const caps = input.capabilities ?? [];
    if (caps.includes('claude-live-permission-v1') || caps.includes('claude-live-permission-v2')) return 'rpc';
    return 'allow';
}

/** A6：不靠权限卡触发的主动对齐（升级到 bypass 才做）。 */
export function shouldAlignToBypass(input: {
    flavor: string | null | undefined;
    controlledByUser: boolean | null | undefined;
    presence: 'online' | number | null | undefined;
    displayed: string | null | undefined;
    intentSource: IntentSource;
    published: string | null | undefined;
    capabilities: readonly string[] | null | undefined;
    hasPendingRequests: boolean;
    busy: boolean;
}): boolean {
    if (!isClaudeRemoteSession(input)) return false;
    if (input.presence !== 'online' || input.busy) return false;
    if (input.displayed !== 'bypassPermissions' && input.displayed !== 'yolo') return false;
    if (input.intentSource !== 'local' && input.intentSource !== 'override') return false;
    if (input.published === 'bypassPermissions') return false;
    const caps = input.capabilities ?? [];
    if (caps.includes('claude-live-permission-v2')) return true;
    return caps.includes('claude-live-permission-v1') && input.hasPendingRequests;
}

/**
 * 从 old/new agentState 提取新出现的请求（含初始加载：old 为空时全部算新）。
 * 只在 agentStateVersion 前进时比较——陈旧的 fetch 回退不得重触发。
 */
export function newPermissionRequests(
    oldState: { agentStateVersion?: number | null; requests?: Record<string, { tool: string; kind?: string | null }> | null } | null | undefined,
    newState: { agentStateVersion?: number | null; requests?: Record<string, { tool: string; kind?: string | null }> | null } | null | undefined,
): Array<{ id: string; tool: string; kind?: string | null }> {
    if (!newState?.requests) return [];
    if (oldState && (newState.agentStateVersion ?? 0) <= (oldState.agentStateVersion ?? 0)) return [];
    const oldRequests = oldState?.requests ?? {};
    const out: Array<{ id: string; tool: string; kind?: string | null }> = [];
    for (const [id, request] of Object.entries(newState.requests)) {
        if (oldRequests[id]) continue;
        out.push({ id, tool: request.tool, kind: request.kind });
    }
    return out;
}

/** Pure: run the yolo decision for each candidate request of one session. */
export function collectYoloDecisions(input: {
    sessionId: string;
    metadata: { flavor?: string | null; variant?: string | null; permissionMode?: string | null; capabilities?: readonly string[] | null } | null | undefined;
    controlledByUser: boolean | null | undefined;
    presence: 'online' | number | null | undefined;
    localMode: string | null | undefined;
    resolvedMode: string | null | undefined;
    overrides: AgentDefaultOverrides | null | undefined;
    busy: boolean;
    requests: Array<{ id: string; tool: string; kind?: string | null }>;
}): YoloEnforcementDecision[] {
    if (input.requests.length === 0) return [];
    const flavor = input.metadata?.flavor;
    const overrideMode = getAgentDefaultOverride(input.overrides, flavor).permissionMode;
    const published = input.metadata?.permissionMode;
    const displayed = input.resolvedMode ?? overrideMode ?? getCodeAgentDefaults(flavor).permissionMode;
    const intentSource = resolveIntentSource({ published, local: input.localMode, override: overrideMode });
    const out: YoloEnforcementDecision[] = [];
    for (const request of input.requests) {
        const action = decideYoloEnforcement({
            flavor,
            variant: input.metadata?.variant,
            controlledByUser: input.controlledByUser,
            presence: input.presence,
            displayed,
            intentSource,
            capabilities: input.metadata?.capabilities,
            busy: input.busy,
            request: { tool: request.tool, kind: request.kind },
        });
        if (action !== 'skip') out.push({ sessionId: input.sessionId, requestId: request.id, tool: request.tool, action });
    }
    return out;
}
