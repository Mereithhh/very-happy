/**
 * B-923: copy for the main agent's tool cards and its docked column — zh / en
 * (the mainAgentCopy pattern; kept apart so the settings copy has one owner).
 */

import type { FieldKey, ToolCardKind, ToolCardView, ToolLink, ToolStatus } from './mainAgentToolView';

export interface MainAgentToolCopy {
    kind: Record<ToolCardKind, string>;
    tool: Record<string, string>;
    status: Record<ToolStatus, string>;
    field: Record<FieldKey, string>;
    link: (link: ToolLink) => string;
    toNew: string;
    acceptance: string;
    options: string;
    more: (n: number) => string;
    count: (n: number) => string;
    raw: string;
    rawInput: string;
    rawResult: string;
    /** plain-language reason for a receipt error code; null = show the receipt's own text */
    error: (code: string | undefined) => string | null;
    blocked: string;
    unavailable: string;
    awaiting: string;
    firstPromptFailed: string;
    // dock
    dockResize: string;
    dockResizeHint: string;
    dockCollapse: string;
    paletteClose: string;
}

const zh: MainAgentToolCopy = {
    kind: {
        delegate: '派活给团队', 'lead-message': '给 Lead 留言', session: '会话', issue: 'Issue', todo: '待办', note: '项目日志', board: '汇报板',
        decision: '需要你决定', lifecycle: '会话操作', list: '列表', blocked: '被安全阀拦下', unavailable: '暂不可用', error: '出错了',
    },
    tool: {
        teams_list: '团队列表', lead_delegate: '派活给团队', lead_message: '给 Lead 留言',
        issue_list: 'Issue 列表', issue_create: '新建 Issue', issue_assign: '分配 Issue', issue_comment: '评论 Issue', issue_get: '查看 Issue',
        todo_list: '待办列表', todo_add: '新建待办', todo_complete: '完成待办',
        project_list: '项目列表', project_context: '读项目', project_note: '写项目日志',
        session_wrapup: '请会话收尾', session_handoff: '交接会话', session_restart: '重启会话',
        sessions_list: '会话列表', session_read: '读会话', session_send: '发消息给会话', session_spawn: '新开会话', session_kill: '停止会话', session_archive: '归档会话',
        session_message: '给会话发消息', session_peers: '相邻会话',
        terminals_list: '终端列表', terminal_read: '读终端', terminal_send: '向终端输入',
        owner_board_post: '发到汇报板', owner_board_update: '更新汇报板', owner_board_resolve: '关闭汇报板卡片', owner_board_list: '汇报板列表',
        dispatch_approved: '执行已批准的派活', automation_create: '新建自动化', automation_update: '修改自动化',
    },
    status: {
        running: '进行中', delivered: '已送达', stored: '已存，对方上线后读', sent: '已发送', spawned: '已开启', done: '完成', recorded: '已记录', posted: '已发出', updated: '已更新', resolved: '已关闭',
        queued: '已排队', 'in-progress': '正在进行', 'scheduled-idle': '空闲后重启', 'scheduled-now': '立即重启', already: '已在队列，未重复发送',
        awaiting: '等批准', approved: '已批准并执行', 'draft-only': '只出草稿', dropped: '已拒绝', 'not-approved': '未批准',
        blocked: '已拦下', 'not-available': '暂不可用', failed: '失败',
    },
    field: {
        team: '团队', lead: 'Lead', task: '任务', directory: '目录', agent: 'Agent', title: '标题', risk: '风险', kind: '类型', session: '会话', from: '从', to: '到',
        when: '时机', version: '版本', key: '编号', assignee: '负责', priority: '优先级', project: '项目', terminal: '终端', approval: '审批号', choice: '选择', outcome: '结果',
    },
    link: (l) => {
        if (l.kind === 'board') return '去汇报板';
        if (l.kind === 'settings') return '主 agent 设置';
        if (l.kind === 'issue') return `打开 ${l.ref}`;
        return { lead: '打开 Lead 会话', target: '打开会话', from: '打开原会话', to: '打开接手会话' }[l.role];
    },
    toNew: '新会话',
    acceptance: '验收',
    options: '选项',
    more: (n) => `还有 ${n} 条`,
    count: (n) => `${n} 条`,
    raw: '原始数据',
    rawInput: '参数',
    rawResult: '回执',
    error: (code) => {
        switch (code) {
            case 'lead_unreachable': return '这个团队的 Lead 不在线或没有 Lead 会话，消息没送到。';
            case 'risk_required': return '派活没有标风险等级（none / external / production），没有派出。';
            case 'board_unavailable': return '汇报板不可用，需要你批准的派活一律不执行。';
            case 'approval_not_found': return '找不到这次审批记录，没有执行。';
            case 'card_tampered': return '决定卡在批准前被改过，为安全起见没有执行。';
            case 'approval_mismatch': return '要执行的内容和你批准的不一致，没有执行。';
            case 'not_approved': return '这张决定卡没有被你批准。';
            case 'dispatch_failed': return '已批准，但执行时出错，可以重试。';
            case 'tool_unavailable': return '执行这次派活的工具在当前版本不可用。';
            case 'reserved_card': return '派活决定卡只能由安全闸发出，主 agent 不能自己改。';
            case 'project_not_member': return '服务器版本太旧，还不接受主 agent 写项目日志。';
            case 'not_available': return '当前 Very Happy 版本还不支持这个操作。';
            case 'first_prompt_failed': return '会话已开启，但第一条消息没发出去。';
            default: return null;
        }
    },
    blocked: '主 agent 不能直接对外发送消息或写生产环境，这次调用被安全阀拦下了。要做这件事，请让它派活给会话并标明风险，由你在汇报板批准。',
    unavailable: '当前 Very Happy 版本还不支持这个操作，升级 CLI 后可用。',
    awaiting: '这次派活会对外可见或改生产，已放到汇报板等你决定。',
    firstPromptFailed: '会话已开启，但第一条消息没发出去。',
    dockResize: '调整主 agent 栏宽度',
    dockResizeHint: '拖动调整宽度 · 双击恢复默认',
    dockCollapse: '收起主 agent',
    paletteClose: '关闭主 agent',
};

const en: MainAgentToolCopy = {
    kind: {
        delegate: 'Work for a team', 'lead-message': 'Message to a Lead', session: 'Session', issue: 'Issue', todo: 'Todo', note: 'Project log', board: 'Board',
        decision: 'Needs your decision', lifecycle: 'Session action', list: 'List', blocked: 'Stopped by the safety gate', unavailable: 'Not available', error: 'Error',
    },
    tool: {
        teams_list: 'Teams', lead_delegate: 'Work for a team', lead_message: 'Message to a Lead',
        issue_list: 'Issues', issue_create: 'New issue', issue_assign: 'Assign issue', issue_comment: 'Comment on issue', issue_get: 'Read issue',
        todo_list: 'Todos', todo_add: 'New todo', todo_complete: 'Complete todo',
        project_list: 'Projects', project_context: 'Read project', project_note: 'Project log entry',
        session_wrapup: 'Ask to wrap up', session_handoff: 'Hand off session', session_restart: 'Restart session',
        sessions_list: 'Sessions', session_read: 'Read session', session_send: 'Send to session', session_spawn: 'New session', session_kill: 'Stop session', session_archive: 'Archive session',
        session_message: 'Message a session', session_peers: 'Nearby sessions',
        terminals_list: 'Terminals', terminal_read: 'Read terminal', terminal_send: 'Type into terminal',
        owner_board_post: 'Post to board', owner_board_update: 'Update board card', owner_board_resolve: 'Close board card', owner_board_list: 'Board items',
        dispatch_approved: 'Run approved work', automation_create: 'New automation', automation_update: 'Edit automation',
    },
    status: {
        running: 'Running', delivered: 'Delivered', stored: 'Stored for its next turn', sent: 'Sent', spawned: 'Started', done: 'Done', recorded: 'Recorded', posted: 'Posted', updated: 'Updated', resolved: 'Closed',
        queued: 'Queued', 'in-progress': 'In progress', 'scheduled-idle': 'Restarts when idle', 'scheduled-now': 'Restarting now', already: 'Already queued, not sent twice',
        awaiting: 'Waiting for approval', approved: 'Approved and run', 'draft-only': 'Draft only', dropped: 'Declined', 'not-approved': 'Not approved',
        blocked: 'Stopped', 'not-available': 'Not available', failed: 'Failed',
    },
    field: {
        team: 'Team', lead: 'Lead', task: 'Task', directory: 'Directory', agent: 'Agent', title: 'Title', risk: 'Risk', kind: 'Kind', session: 'Session', from: 'From', to: 'To',
        when: 'When', version: 'Version', key: 'Key', assignee: 'Assignee', priority: 'Priority', project: 'Project', terminal: 'Terminal', approval: 'Approval', choice: 'Choice', outcome: 'Outcome',
    },
    link: (l) => {
        if (l.kind === 'board') return 'Open board';
        if (l.kind === 'settings') return 'Main agent settings';
        if (l.kind === 'issue') return `Open ${l.ref}`;
        return { lead: 'Open Lead session', target: 'Open session', from: 'Open source session', to: 'Open receiving session' }[l.role];
    },
    toNew: 'New session',
    acceptance: 'Acceptance',
    options: 'Options',
    more: (n) => `${n} more`,
    count: (n) => `${n} item${n === 1 ? '' : 's'}`,
    raw: 'Raw data',
    rawInput: 'Input',
    rawResult: 'Receipt',
    error: (code) => {
        switch (code) {
            case 'lead_unreachable': return 'The team\'s Lead is offline or has no session; nothing was delivered.';
            case 'risk_required': return 'The work had no risk level (none / external / production), so it was not sent.';
            case 'board_unavailable': return 'The board is unavailable, so work that needs your approval is not run.';
            case 'approval_not_found': return 'No record of this approval was found; nothing was run.';
            case 'card_tampered': return 'The decision card changed before approval; nothing was run, to be safe.';
            case 'approval_mismatch': return 'What would run differs from what you approved; nothing was run.';
            case 'not_approved': return 'You did not approve this decision card.';
            case 'dispatch_failed': return 'Approved, but running it failed; it can be retried.';
            case 'tool_unavailable': return 'The tool for this work is not available in this version.';
            case 'reserved_card': return 'Decision cards for dispatch come only from the safety gate; the main agent cannot change them.';
            case 'project_not_member': return 'This server is too old to take project log entries from the main agent.';
            case 'not_available': return 'This Very Happy version does not support this yet.';
            case 'first_prompt_failed': return 'The session started, but its first message was not sent.';
            default: return null;
        }
    },
    blocked: 'The main agent cannot send anything outside Very Happy or write to production directly, so the safety gate stopped this call. To do it, have it hand the work to a session with a risk level and approve it on the board.',
    unavailable: 'This Very Happy version does not support this yet; update the CLI to use it.',
    awaiting: 'This work would be visible outside or change production, so it is on the board waiting for your decision.',
    firstPromptFailed: 'The session started, but its first message was not sent.',
    dockResize: 'Resize the main agent column',
    dockResizeHint: 'Drag to resize · double-click to reset',
    dockCollapse: 'Collapse the main agent',
    paletteClose: 'Close the main agent',
};

export function mainAgentToolCopy(lang: string): MainAgentToolCopy {
    return lang.startsWith('zh') ? zh : en;
}

/** The plain-language line under the header, when the card has one. */
export function explain(view: ToolCardView, copy: MainAgentToolCopy): string | null {
    if (view.kind === 'blocked') return copy.blocked;
    if (view.kind === 'unavailable') return copy.unavailable;
    if (view.status === 'awaiting') return copy.awaiting;
    const known = copy.error(view.errorCode);
    if (known) return known;
    if (view.status === 'failed' || view.status === 'not-approved') return view.errorText ?? null;
    return null;
}
