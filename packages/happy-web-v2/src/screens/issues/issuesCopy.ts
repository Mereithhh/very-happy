import { useTranslation } from '@/i18n/useTranslation';

/** B-873 Issues copy (zh-Hans / English, same pattern as projectCopy.ts). */
const zh = {
    lang: 'zh' as 'zh' | 'en',
    title: 'Issues', newIssue: '新建 issue', list: '列表', board: '看板', view: '视图',
    all: '全部', assigned: '指派给我', waiting: '等我处理', created: '我创建的', scope: '范围',
    search: '搜索标题或编号', filters: '筛选', clear: '清除筛选', external: '外部待办',
    status: '状态', project: '项目', assignee: '指派', label: '标签', priority: '优先级', due: '截止', parent: '父 issue', labels: '标签',
    statuses: { backlog: '待规划', todo: '待办', in_progress: '进行中', in_review: '待验收', blocked: '卡住', done: '已完成', cancelled: '已取消', other: '其他' } as Record<string, string>,
    priorities: { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无' } as Record<string, string>,
    noProject: '无项目', none: '无', self: '我', unknownAssignee: '未知', agentOn: (agent: string, machine: string) => `${agent} · ${machine}`,
    empty: '还没有 issue', emptyFiltered: '没有符合筛选的 issue', emptyHint: '新建一个 issue，可以自己做，也可以指派给 agent。', loading: '正在加载…', loadFailed: '加载失败', retry: '重试',
    serverVisible: 'Issue 的标题、描述和评论存在服务器上，对服务器可见（与项目、团队同一信任级别）。',
    collapse: (n: number) => `收起 ${n} 条`, expand: (n: number) => `展开 ${n} 条`, moveTo: '改状态', more: '更多操作', openIssue: (key: string) => `打开 ${key}`,
    running: '执行中', idleStill: 'agent 空闲 · 仍进行中', idleStillHint: 'agent 停下了，但没有把状态改成待验收或卡住。看一眼执行记录，再决定继续、退回还是完成。',
    // detail
    notFound: '找不到这个 issue', description: '描述', descriptionPh: '写清楚要做什么、验收标准（Markdown）', edit: '编辑', save: '保存', cancel: '取消', saved: '已保存',
    conflict: '描述已被别处修改，已载入最新内容，请在此基础上再改', titlePh: '标题', delete: '删除 issue', deleteConfirm: '删除这个 issue？执行过的会话不会被删除。', deleted: '已删除',
    fields: '属性', timeline: '动态', runs: '执行记录', noRuns: '还没有执行。指派给 agent（状态不是待规划）就会开跑。', children: '子 issue',
    runN: (n: number) => `第 ${n} 次`, triggers: { assign: '指派', mention: '@ 唤起', comment: '评论', retry: '重试' } as Record<string, string>,
    runStatus: { queued: '排队中', claimed: '启动中', running: '运行中', idle: '空闲', ended: '已结束', failed: '失败', cancelled: '已停止', superseded: '已被替代' } as Record<string, string>,
    waitingMachine: (m: string) => `等待 ${m} 上线`, openSession: '打开会话', retryRun: '重试', switchAgent: '换 agent', stop: '停止', ack: '知道了',
    comment: '评论', commentPh: '写评论…  @ 选 agent，/note 开头只记录不唤醒', send: '发送', mention: '提及 agent', mentionLimit: '最多 @ 3 个',
    preview: {
        note: '/note：只记录，不唤醒 agent',
        noAgent: '不会唤醒 agent（没有指派给 agent，可以 @ 一个）',
        inactive: '不会唤醒 agent（当前状态不触发，@ 可以强制唤醒）',
        message: (who: string) => `会排队送进 ${who} 正在运行的会话（不打断）`,
        absorbed: (who: string) => `${who} 正在启动，会读到这条评论`,
        spawn: (who: string) => `会为 ${who} 新开一次执行`,
    },
    delivered: (n: number) => `已送达 · 第 ${n} 次执行`, deliveredMany: (n: number) => `已送达 ${n} 次执行`,
    you: '你', system: '系统', imported: '导入', agentRun: (agent: string, machine: string, n: number) => `${agent} · ${machine} · 第 ${n} 次执行`,
    statusLine: (from: string, to: string) => `状态 ${from} → ${to}`, assignLine: '修改了指派', runQueued: (n: number) => `第 ${n} 次执行已排队`, runFailed: (n: number) => `第 ${n} 次执行失败`, fieldLine: '修改了属性',
    noteTag: '记录', ownerMention: '@ 你',
    // assignee picker
    assignTitle: '指派', kindNone: '无', kindSelf: '我', kindAgent: 'Agent', machine: '机器', agent: 'Agent', model: '模型', modelDefault: '默认（跟随机器 / 项目）',
    directory: '目录', directoryPh: '留空 = 项目在这台机器上的目录', offline: '离线', cliOld: 'CLI 过旧', noMachines: '没有在线机器', notInstalled: '未安装',
    backlogNote: '待规划状态只记归属，不会开跑；改到「待办」才开始执行。', runsOnSave: '保存后会立即派给这个 agent 开跑。', apply: '确定',
    // new issue
    newTitle: '新建 issue', create: '创建', creating: '正在创建…', titleRequired: '填写标题', addLabel: '添加标签', labelPh: '回车添加',
    // decisions
    decisions: '需要我决策', decisionsHint: '待验收、卡住和没起来的执行', accept: '完成', reject: '退回', rejectTitle: '退回这个 issue？', rejectBody: '状态改回「待办」。附言会作为你的评论发给 agent。',
    rejectPh: '还差什么（可选）', reviewTitle: (key: string, title: string) => `${key} 待验收 · ${title}`, blockedTitle: (key: string, title: string) => `${key} 卡住 · ${title}`, failedTitle: (key: string) => `${key} 执行失败`,
    accepted: '已完成', rejected: '已退回', failed: '操作失败',
    // palette
    paletteGroup: 'Issues', paletteNew: (q: string) => `新建 issue：${q}`, paletteNewEmpty: '新建 issue',
    // sidebar / project
    sidebarRunning: '运行中', projectSection: 'Issues', projectEmpty: '这个项目还没有未关闭的 issue', quickAddPh: '快速新建 issue，回车创建', viewAll: '查看全部',
    disabled: '这个服务器没有开启 Issues',
    chip: (key: string) => `本会话属于 ${key}`,
};
type IssuesCopy = typeof zh;
const en: IssuesCopy = {
    lang: 'en',
    title: 'Issues', newIssue: 'New issue', list: 'List', board: 'Board', view: 'View',
    all: 'All', assigned: 'Assigned to me', waiting: 'Waiting on me', created: 'Created by me', scope: 'Scope',
    search: 'Search title or key', filters: 'Filters', clear: 'Clear filters', external: 'External todos',
    status: 'Status', project: 'Project', assignee: 'Assignee', label: 'Label', priority: 'Priority', due: 'Due', parent: 'Parent', labels: 'Labels',
    statuses: { backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled', other: 'Other' },
    priorities: { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None' },
    noProject: 'No project', none: 'None', self: 'Me', unknownAssignee: 'Unknown', agentOn: (agent, machine) => `${agent} · ${machine}`,
    empty: 'No issues yet', emptyFiltered: 'No issues match these filters', emptyHint: 'Create an issue to do yourself or assign to an agent.', loading: 'Loading…', loadFailed: 'Could not load issues', retry: 'Retry',
    serverVisible: 'Issue titles, descriptions and comments are stored on the server and visible to it (same trust level as Projects and Teams).',
    collapse: (n) => `Hide ${n}`, expand: (n) => `Show ${n}`, moveTo: 'Change status', more: 'More actions', openIssue: (key) => `Open ${key}`,
    running: 'Running', idleStill: 'Agent idle · still in progress', idleStillHint: 'The agent stopped without moving the issue to In review or Blocked. Check the runs, then continue, return or close it.',
    notFound: 'Issue not found', description: 'Description', descriptionPh: 'What needs doing and how it will be checked (Markdown)', edit: 'Edit', save: 'Save', cancel: 'Cancel', saved: 'Saved',
    conflict: 'The description changed elsewhere; the latest text is loaded — edit on top of it', titlePh: 'Title', delete: 'Delete issue', deleteConfirm: 'Delete this issue? Sessions it ran are kept.', deleted: 'Deleted',
    fields: 'Properties', timeline: 'Activity', runs: 'Runs', noRuns: 'No runs yet. Assigning it to an agent (outside Backlog) starts one.', children: 'Sub-issues',
    runN: (n) => `Run ${n}`, triggers: { assign: 'Assigned', mention: '@ mention', comment: 'Comment', retry: 'Retry' },
    runStatus: { queued: 'Queued', claimed: 'Starting', running: 'Running', idle: 'Idle', ended: 'Ended', failed: 'Failed', cancelled: 'Stopped', superseded: 'Superseded' },
    waitingMachine: (m) => `Waiting for ${m} to come online`, openSession: 'Open session', retryRun: 'Retry', switchAgent: 'Switch agent', stop: 'Stop', ack: 'Dismiss',
    comment: 'Comment', commentPh: 'Write a comment…  @ picks an agent, /note records without waking one', send: 'Send', mention: 'Mention agent', mentionLimit: 'Up to 3 mentions',
    preview: {
        note: '/note: recorded only, no agent is woken',
        noAgent: 'Wakes no agent (not assigned to one — @ one to wake it)',
        inactive: 'Wakes no agent (this status does not trigger; an @ always does)',
        message: (who) => `Queued into ${who}’s running session (no interruption)`,
        absorbed: (who) => `${who} is starting and will read this comment`,
        spawn: (who) => `Starts a new run for ${who}`,
    },
    delivered: (n) => `Delivered · run ${n}`, deliveredMany: (n) => `Delivered to ${n} runs`,
    you: 'You', system: 'System', imported: 'Imported', agentRun: (agent, machine, n) => `${agent} · ${machine} · run ${n}`,
    statusLine: (from, to) => `Status ${from} → ${to}`, assignLine: 'Changed the assignee', runQueued: (n) => `Run ${n} queued`, runFailed: (n) => `Run ${n} failed`, fieldLine: 'Changed properties',
    noteTag: 'Note', ownerMention: '@ you',
    assignTitle: 'Assign', kindNone: 'None', kindSelf: 'Me', kindAgent: 'Agent', machine: 'Machine', agent: 'Agent', model: 'Model', modelDefault: 'Default (machine / project)',
    directory: 'Folder', directoryPh: 'Empty = the project’s folder on this machine', offline: 'Offline', cliOld: 'CLI too old', noMachines: 'No machine online', notInstalled: 'Not installed',
    backlogNote: 'Backlog only records the owner; nothing runs until it moves to Todo.', runsOnSave: 'Saving dispatches it to this agent right away.', apply: 'Apply',
    newTitle: 'New issue', create: 'Create', creating: 'Creating…', titleRequired: 'Enter a title', addLabel: 'Add label', labelPh: 'Enter to add',
    decisions: 'Needs my decision', decisionsHint: 'In review, blocked, and runs that never started', accept: 'Done', reject: 'Return', rejectTitle: 'Return this issue?', rejectBody: 'It goes back to Todo. Your note is posted as your comment to the agent.',
    rejectPh: 'What is still missing (optional)', reviewTitle: (key, title) => `${key} in review · ${title}`, blockedTitle: (key, title) => `${key} blocked · ${title}`, failedTitle: (key) => `${key} run failed`,
    accepted: 'Done', rejected: 'Returned', failed: 'Something went wrong',
    paletteGroup: 'Issues', paletteNew: (q) => `New issue: ${q}`, paletteNewEmpty: 'New issue',
    sidebarRunning: 'Running', projectSection: 'Issues', projectEmpty: 'No open issues in this project', quickAddPh: 'Quick new issue, Enter to create', viewAll: 'View all',
    disabled: 'Issues are not enabled on this server',
    chip: (key) => `This session belongs to ${key}`,
};

export function issuesCopyFor(lang: string): IssuesCopy {
    return lang.startsWith('zh') ? zh : en;
}
export function useIssuesCopy(): IssuesCopy {
    return issuesCopyFor(useTranslation().lang);
}
export type { IssuesCopy };
