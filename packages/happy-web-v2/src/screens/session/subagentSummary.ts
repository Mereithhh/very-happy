/**
 * 子代理指针行的派生数据（B-260 第一批，纯函数）。
 *
 * 输入是 reducer 挂在 Agent/Task 工具调用上的 `children`（一层树）。第一批
 * 刻意「诚实」：没有 task_started/progress/notification 事实源之前，不派生
 * 状态、不派生耗时、不声称结果——后台子代理的 tool_result 只是「Async agent
 * launched」存根，把它当「已完成」正是要修的显示谎言（B-260-P2 引入真状态）。
 */
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { compareMessagesNewestFirst } from '@/sync/messageOrder';
import { toolDetail, toolLabel } from './toolInfo';

export interface SubagentSummary {
    /** description ?? name ?? subagent_type ?? null（调用方兜底 i18n「子代理」）。 */
    title: string | null;
    /** mono 中性徽章内容。 */
    subtype: string | null;
    toolCount: number;
    /** 子工具调用，按会话顺序（seq → createdAt → sortOrder 升序）。 */
    childTools: ToolCallMessage[];
    /** 最近 N 条 `[Tool] detail` 一行式摘要，最新在最后。 */
    recent: string[];
}

function asTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function isSubagentToolName(name: string): boolean {
    return name === 'Task' || name === 'Agent';
}

export function buildSubagentSummary(message: ToolCallMessage, recentLimit = 3): SubagentSummary {
    const input = message.tool.input ?? {};
    const title = asTrimmedString((input as Record<string, unknown>).description)
        ?? asTrimmedString((input as Record<string, unknown>).name)
        ?? asTrimmedString((input as Record<string, unknown>).subagent_type);
    const subtype = asTrimmedString((input as Record<string, unknown>).subagent_type);
    // children arrive in tracer push order; DESC pages within one batch are
    // fixed by B-261, but cross-page loads still prepend newer pages — sort
    // here so the log reads chronologically regardless (r3 must-fix).
    const childTools = (message.children ?? [])
        .filter((c): c is ToolCallMessage => c.kind === 'tool-call')
        .sort((a, b) => compareMessagesNewestFirst(b as Message, a as Message));
    const recent = childTools.slice(-recentLimit).map((child) => {
        const label = toolLabel(child.tool);
        const detail = toolDetail(child.tool);
        return detail && detail !== label ? `[${label}] ${detail}` : `[${label}]`;
    });
    return { title, subtype, toolCount: childTools.length, childTools, recent };
}
