import { useTranslation } from '@/i18n/useTranslation';
export function useTeamNavigationCopy() {
  return useTranslation().lang.startsWith('zh') ? {
    failed: '启动需处理 · 查看原因', noSession: '尚无会话 · 查看团队', title: '团队', history: '会话记录', members: '位成员', lead: '负责人', member: '成员', progress: '团队进展', expand: '展开团队', collapse: '收起团队', openBoard: '打开看板', openLead: '和负责人对话', leadStatus: '负责人',
    inactiveCount: (n: number) => `已停用 ${n} 个`, showInactive: '显示已停用成员', hideInactive: '收起已停用成员', stopping: '回收需要处理', inactiveHint: '已归档、已退出且没有未完成任务，或 7 天无活动的成员；仍可查看会话记录和重新指派任务。',
    preparing: '正在准备团队', show: '显示团队入口', hint: '隐藏入口不会停止或删除团队，已有团队仍在历史列表中。',
  } : {
    failed: 'Startup needs attention · view details', noSession: 'No session · view team', title: 'Teams', history: 'Conversation history', members: 'members', lead: 'Lead', member: 'Member', progress: 'Team progress', expand: 'Expand team', collapse: 'Collapse team', openBoard: 'Open board', openLead: 'Chat with the lead', leadStatus: 'Lead',
    inactiveCount: (n: number) => `${n} inactive`, showInactive: 'Show inactive members', hideInactive: 'Hide inactive members', stopping: 'Cleanup needs attention', inactiveHint: 'Archived, exited with no open task, or idle for 7 days. Their history stays open and they can still be assigned work.',
    preparing: 'Team is being prepared', show: 'Show Teams entry', hint: 'Hiding the entry does not stop or delete teams. Existing teams stay in history.',
  };
}
