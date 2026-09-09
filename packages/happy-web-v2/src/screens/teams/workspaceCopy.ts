import { useTranslation } from '@/i18n/useTranslation';
const en = {
  lastEvent: 'Last event', title: 'Happy Bot', overview: 'Workspace', schedules: 'Schedules', settings: 'Settings',
  intro: 'Give your bot a goal. Follow the team’s work here.', create: 'New team',
  talk: 'Talk to lead', newTask: 'New task', guide: 'Getting started & skills',
  noTeams: 'Your first team starts with a conversation', noTeamsHint: 'Choose a project and describe your goal. We will prepare the lead and connect the team.',
  noTasks: 'Ready for a goal', noTasksHint: 'Ask the lead to inspect a project or build a feature. Tasks appear here as work is delegated.',
  noMembers: 'Start the team to create its lead', members: 'Team members',
  queued: 'Queued', running: 'In progress', submitted: 'Review', finished: 'Finished',
  emptyLane: 'No tasks', close: 'Close', details: 'Task details', controls: 'Task actions',
  result: 'Result', waiting: 'No result submitted yet', criteria: 'Acceptance criteria',
  online: 'Machine online', offline: 'Machine offline', progress: 'accepted',
  idle: 'No active assignment', assigned: 'Assigned tasks', lead: 'Lead',
  cleanup: 'Cleanup', cleanupPending: 'Cleanup pending', cleanupFailed: 'Cleanup needs attention',
  cleanupDone: 'Cleaned up', cleanupNone: 'Not requested', attention: 'Execution needs attention',
  cancelled: 'Cancelled', unnamedMachine: 'Team machine',
};
const zh: typeof en = {
  lastEvent: '最近事件', title: 'Happy Bot', overview: '工作台', schedules: '定时安排', settings: '团队设置',
  intro: '告诉 Bot 你的目标，在这里看团队如何推进。', create: '新建团队',
  talk: '找负责人聊聊', newTask: '新建任务', guide: '使用与安装指南',
  noTeams: '从一句需求，开始第一个团队', noTeamsHint: '选择项目，说清目标，系统会准备负责人并连接团队。',
  noTasks: '准备好接收目标', noTasksHint: '让负责人检查一个项目，或开发一个功能。派出的任务会直接展示在这里。',
  noMembers: '启动团队后，负责人会出现在这里', members: '团队成员',
  queued: '待开始', running: '进行中', submitted: '待验收', finished: '已结束',
  emptyLane: '暂无任务', close: '关闭', details: '任务详情', controls: '处理任务',
  result: '交付结果', waiting: '尚未提交结果', criteria: '验收标准',
  online: '机器在线', offline: '机器离线', progress: '已验收',
  idle: '暂无进行中的任务', assigned: '分配的任务', lead: '负责人',
  cleanup: '资源回收', cleanupPending: '等待回收', cleanupFailed: '回收需要处理',
  cleanupDone: '已回收', cleanupNone: '尚未请求', attention: '执行需要处理',
  cancelled: '已取消', unnamedMachine: '执行机器',
};
export function useWorkspaceCopy() { return useTranslation().lang === 'zh-Hans' ? zh : en; }
