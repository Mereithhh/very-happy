import { useTranslation } from '@/i18n/useTranslation';

/** B-648 project page copy (zh-Hans / English, same pattern as teamNavigationCopy). */
export function useProjectCopy() {
  const zh = useTranslation().lang === 'zh-Hans';
  return zh ? {
    back: '会话', overview: '概览', context: '上下文', settings: '项目设置', composerPlaceholder: (name: string) => `在 ${name} 开新会话…`, send: '发送', sending: '正在创建…',
    noFolder: '还没有目录——先在设置里加一个目录才能在这里开会话', folder: '目录', agent: 'Agent',
    attention: '等你处理', running: '进行中', doneToday: '今日完成', idle: '空闲', empty: '还没有会话', teams: '团队', automations: '定时自动化',
    members: '成员', injected: (v: number) => `已注入 v${v}`, stale: (v: number, l: number) => `旧版 v${v}（下一轮更新到 v${l}）`, pending: '下一轮注入', none: '未注入', noneRestart: '未注入 · 重启会话以启用', unknown: '状态未知',
    injectionSummary: (c: number, s: number, n: number) => `已注入最新 ${c} · 待更新 ${s} · 未注入 ${n}`,
    instructions: '说明', instructionsHint: '人写的稳定规则，会放进项目里每个会话的首条消息前；更新后下一轮带上一行提示，不会唤醒空闲会话。',
    edit: '编辑', save: '保存', cancel: '取消', history: '历史版本', versionLine: (v: number, d: number, o: number) => `v${v} · 已送达 ${d} · 旧版 ${o}`, noInstructions: '还没有说明', conflict: (v: number) => `说明已被改到 v${v}，已载入最新内容，请在此基础上再改`,
    tooLong: '超过 8KB 上限', log: '记录', logHint: '决定 / 发现 / 交接；agent 可直接写，你可以撤销。', all: '全部', decision: '决定', finding: '发现', handoff: '交接',
    revoke: '撤销', revoked: '已撤销', superseded: '已被替代', addNote: '添加记录', titlePh: '一句话标题', bodyPh: '细节（可选）', byUser: '你', noLog: '还没有记录',
    serverVisible: '项目的说明、记录和留言存在服务器上，对服务器可见（与团队同一信任级别）；会话正文仍按原方式加密。',
    rename: '名称', goal: '目标', folders: '目录', primary: '主目录', makePrimary: '设为主目录', remove: '移除', addFolder: '添加目录', path: '路径', machine: '机器',
    attachTeam: '关联团队', detach: '解除关联', newTeamHere: '在此项目中新建团队', linkTeam: '关联已有团队', noTeams: '还没有团队。团队的负责人和成员会共享这个项目的说明和记录。', teamNoFolder: '这个团队没有已知的工作目录，无法加入项目', viaTeam: '团队成员', removeFromProject: '从项目移出', archive: '归档项目', unarchive: '取消归档', delete: '删除项目', deleteConfirm: '删除项目？会话不会被删除，只是不再属于这个项目。',
    notFound: '项目不存在或已被删除', unavailable: '这个服务器还不支持项目', loading: '正在加载…', failed: '操作失败', saved: '已保存',
  } : {
    back: 'Sessions', overview: 'Overview', context: 'Context', settings: 'Project settings', composerPlaceholder: (name: string) => `Start a session in ${name}…`, send: 'Send', sending: 'Creating…',
    noFolder: 'No folder yet — add one in settings to start sessions here', folder: 'Folder', agent: 'Agent',
    attention: 'Waiting for you', running: 'Running', doneToday: 'Done today', idle: 'Idle', empty: 'No sessions yet', teams: 'Teams', automations: 'Scheduled automations',
    members: 'Members', injected: (v: number) => `Injected v${v}`, stale: (v: number, l: number) => `Older v${v} (v${l} on next turn)`, pending: 'On next turn', none: 'Not injected', noneRestart: 'Not injected · restart the session to enable', unknown: 'Unknown',
    injectionSummary: (c: number, s: number, n: number) => `Latest ${c} · updating ${s} · not injected ${n}`,
    instructions: 'Instructions', instructionsHint: 'Stable rules you write. They go in front of each project session\'s first message; after an update the next turn carries a one-line note — idle sessions are never woken.',
    edit: 'Edit', save: 'Save', cancel: 'Cancel', history: 'History', versionLine: (v: number, d: number, o: number) => `v${v} · delivered ${d} · older ${o}`, noInstructions: 'No instructions yet', conflict: (v: number) => `Instructions changed to v${v} meanwhile; the latest text is loaded — edit on top of it`,
    tooLong: 'Over the 8KB limit', log: 'Log', logHint: 'Decisions, findings, handoffs. Agents write directly; you can revoke.', all: 'All', decision: 'Decision', finding: 'Finding', handoff: 'Handoff',
    revoke: 'Revoke', revoked: 'Revoked', superseded: 'Superseded', addNote: 'Add entry', titlePh: 'One-line title', bodyPh: 'Details (optional)', byUser: 'You', noLog: 'No entries yet',
    serverVisible: 'Project instructions, log and messages are stored on the server and visible to it (same trust level as Teams); session content stays encrypted as before.',
    rename: 'Name', goal: 'Goal', folders: 'Folders', primary: 'Primary', makePrimary: 'Make primary', remove: 'Remove', addFolder: 'Add folder', path: 'Path', machine: 'Machine',
    attachTeam: 'Link team', detach: 'Unlink', newTeamHere: 'New team in this project', linkTeam: 'Link a team', noTeams: 'No teams yet. A team’s lead and members share this project’s instructions and log.', teamNoFolder: 'This team has no known working folder, so it cannot join the project', viaTeam: 'Team member', removeFromProject: 'Remove from project', archive: 'Archive project', unarchive: 'Unarchive', delete: 'Delete project', deleteConfirm: 'Delete the project? Sessions are kept; they just leave the project.',
    notFound: 'Project not found or deleted', unavailable: 'This server does not support projects yet', loading: 'Loading…', failed: 'Something went wrong', saved: 'Saved',
  };
}
export type ProjectCopy = ReturnType<typeof useProjectCopy>;
