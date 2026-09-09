import { useTranslation } from '@/i18n/useTranslation';
export function useTeamNavigationCopy() {
  return useTranslation().lang === 'zh-Hans' ? {
    history: '会话记录', members: '位成员', lead: '负责人', member: '成员', progress: '团队进展', expand: '展开团队', collapse: '收起团队',
    preparing: '正在准备团队', show: '显示 Happy Bot 入口', hint: '隐藏入口不会停止或删除团队，已有团队仍在历史列表中。',
  } : {
    history: 'Conversation history', members: 'members', lead: 'Lead', member: 'Member', progress: 'Team progress', expand: 'Expand team', collapse: 'Collapse team',
    preparing: 'Team is being prepared', show: 'Show Happy Bot entry', hint: 'Hiding the entry does not stop or delete teams. Existing teams stay in history.',
  };
}
