import { useTranslation } from '@/i18n/useTranslation';

/** B-648 project page copy (zh-Hans / English, same pattern as teamNavigationCopy). */
export function useProjectCopy() {
  const zh = useTranslation().lang.startsWith('zh');
  return zh ? {
    back: '会话', overview: '概览', context: '上下文', settings: '项目设置', composerPlaceholder: (name: string) => `在 ${name} 开新会话…`, send: '发送', sending: '正在创建…',
    noFolder: '还没有目录，加一个才能在这里开会话', folder: '目录', agent: 'Agent',
    worktreeFolder: (path: string) => `目录 ${path} 是团队成员的临时工作区，不是项目目录。在里面工作的无关会话会被提示加入这个项目。`,
    worktreeRepo: (repo: string) => `它来自仓库 ${repo}。`, worktreeFix: '改成仓库路径', worktreeUnknown: '找不到它对应的仓库：在设置里移除它，再添加仓库路径。', worktreeOpenSettings: '打开设置', worktreeFixed: '目录已改成仓库路径',
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
    // B-757 settings page
    backTo: (name: string) => `返回「${name}」`, basics: '基本信息', description: '描述', descriptionPh: '一句话说明这个项目做什么', basicsHint: '名称和描述显示在侧栏、项目页和项目选择器里。',
    contextTitle: '项目说明', contextHint: '这个项目要做什么、约定、注意事项。所有成员会话都会读到：放在首条消息前，更新后下一轮带上一行提示。', write: '编辑', preview: '预览', bytes: (n: number, max: number) => `${n} / ${max} 字节`, previewEmpty: '没有可预览的内容',
    foldersHint: '成员会话在这些目录里工作；新会话落在这些目录里时会提示加入项目。', noFolders: '还没有目录', change: '修改',
    folderErr: { empty: '填写路径', machine: '选择机器', worktree: '这是团队成员的临时工作区，改填仓库路径', duplicate: '这台机器上已经有这个目录', limit: '目录已达上限' } as Record<string, string>,
    removeFolderTitle: '移除目录？', removeFolderBody: (path: string) => `移除 ${path}？已在里面工作的会话不受影响，但新会话不再提示加入。`,
    teamsHint: '关联的团队里，负责人和成员都属于这个项目，读同一份说明和记录。', moveTeamTitle: '移动团队？', moveTeamBody: (team: string, from: string, to: string) => `团队「${team}」将从「${from}」移到「${to}」，它的负责人和成员会改读「${to}」的说明和记录。`, moveTeam: '移到这个项目', detachTitle: '解除关联？', detachBody: (name: string) => `团队「${name}」的成员会离开这个项目，团队本身不受影响。`,
    sessions: '成员会话', sessionsHint: '属于这个项目的会话。团队成员跟随团队：要移出请解除关联对应团队。', followsTeam: '跟随团队', removeMemberTitle: '从项目移出？', removeMemberBody: (title: string) => `「${title}」将不再属于这个项目，下一轮起不再带项目说明。`,
    danger: '危险区', archiveHint: '归档后项目从侧栏和选择器里隐藏，设置变为只读，可随时取消归档。', archiveConfirm: '归档项目？成员会话保留，只是不再显示在项目下。', deleteHint: '删除后无法恢复。会话不会被删除，只是不再属于这个项目。',
    nameRequired: '填写名称', folderExists: '目录已存在，已切到「选择已有目录」，确认后再添加', archivedNote: '项目已归档：设置只读。在危险区取消归档后可编辑。', open: '打开',
  } : {
    back: 'Sessions', overview: 'Overview', context: 'Context', settings: 'Project settings', composerPlaceholder: (name: string) => `Start a session in ${name}…`, send: 'Send', sending: 'Creating…',
    noFolder: 'No folder yet — add one to start sessions here', folder: 'Folder', agent: 'Agent',
    worktreeFolder: (path: string) => `Folder ${path} is a team member’s temporary worktree, not a project folder. Unrelated sessions working there get asked to join this project.`,
    worktreeRepo: (repo: string) => ` Its repository is ${repo}.`, worktreeFix: 'Use the repository', worktreeUnknown: ' Its repository is unknown: remove it in settings, then add the repository path.', worktreeOpenSettings: 'Open settings', worktreeFixed: 'Folder changed to the repository',
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
    // B-757 settings page
    backTo: (name: string) => `Back to ${name}`, basics: 'Basics', description: 'Description', descriptionPh: 'One line on what this project is for', basicsHint: 'Name and description show in the sidebar, the project page and project pickers.',
    contextTitle: 'Project instructions', contextHint: 'What this project is for, its conventions and caveats. Every member session reads them: they go in front of the first message, and after an update the next turn carries a one-line note.', write: 'Write', preview: 'Preview', bytes: (n: number, max: number) => `${n} / ${max} bytes`, previewEmpty: 'Nothing to preview',
    foldersHint: 'Member sessions work in these folders; a new session in one of them is offered to join the project.', noFolders: 'No folders yet', change: 'Edit',
    folderErr: { empty: 'Enter a path', machine: 'Choose a machine', worktree: 'This is a team member’s temporary worktree; use the repository path', duplicate: 'This machine already has this folder', limit: 'Folder limit reached' } as Record<string, string>,
    removeFolderTitle: 'Remove folder?', removeFolderBody: (path: string) => `Remove ${path}? Sessions already working there are unaffected; new ones are no longer offered to join.`,
    teamsHint: 'A linked team’s lead and members belong to this project and share its instructions and log.', moveTeamTitle: 'Move team?', moveTeamBody: (team: string, from: string, to: string) => `“${team}” moves from “${from}” to “${to}”. Its lead and members will read “${to}”’s instructions and log instead.`, moveTeam: 'Move here', detachTitle: 'Unlink team?', detachBody: (name: string) => `Members of “${name}” leave this project. The team itself is unaffected.`,
    sessions: 'Member sessions', sessionsHint: 'Sessions in this project. Team members follow their team: unlink the team to remove them.', followsTeam: 'Follows team', removeMemberTitle: 'Remove from project?', removeMemberBody: (title: string) => `“${title}” leaves this project; from its next turn it no longer carries the project instructions.`,
    danger: 'Danger zone', archiveHint: 'An archived project is hidden from the sidebar and pickers and its settings become read-only. Unarchive any time.', archiveConfirm: 'Archive the project? Member sessions are kept; they just no longer show under it.', deleteHint: 'Deleting cannot be undone. Sessions are kept; they just leave the project.',
    nameRequired: 'Enter a name', folderExists: 'That folder already exists; switched to “Choose a folder” — add it from there', archivedNote: 'This project is archived, so its settings are read-only. Unarchive it in the danger zone to edit.', open: 'Open',
  };
}
export type ProjectCopy = ReturnType<typeof useProjectCopy>;
