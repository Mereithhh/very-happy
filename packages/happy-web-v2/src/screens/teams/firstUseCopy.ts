import { useTranslation } from '@/i18n/useTranslation';
const en = {
  title: 'Start a team', start: 'Start working', goal: 'What would you like done?', goalHint: 'For example: review this project, fix the most important issues in parallel, and test the changes.',
  project: 'Project folder', browse: 'Choose folder', machine: 'Computer', lead: 'Team lead', automatic: 'We prepare the collaboration instructions and open your lead’s conversation automatically. No skill installation needed here.',
  options: 'Team options', name: 'Team name (optional)', model: 'Model (optional)', modelHint: 'Leave blank to use this agent’s default.', members: 'New members', parallel: 'Tasks progressing at once', settingsHint: 'Applies to new assignments. Running members keep their current configuration. Parents waiting for children do not occupy a work slot.',
  preparing: 'Preparing your team', preparingHint: 'Starting the lead and connecting its conversation. You can leave this page and return from your history.',
  offline: 'This computer is offline. Reconnect it to start a team.', machineRequired: 'Connect a computer to start a team.', upgrade: 'This computer needs a newer CLI to start teams automatically. Check its update status.', machineSettings: 'View computer', unavailable: 'Team collaboration is unavailable for this account. Ordinary conversations still work.',
  failed: 'The team could not start', failedHint: 'Open the task to inspect the failure and recovery options. Do not create another team while the previous launch is uncertain.',
  open: 'Open lead conversation', goalTitle: 'Team goal', progress: 'Progress', membersTitle: 'Who is working', result: 'Delivered result', inspect: 'View task and result',
  member: 'Member', leadLabel: 'Lead', starting: 'Starting', stopped: 'Session ended', unknown: 'Check execution',
  waiting: 'Waiting to start', reviewing: 'Ready for review', accepted: 'Accepted', cancelled: 'Cancelled', working: 'Working on',
  setup: 'Start this team', setupHint: 'Choose a project and describe the goal. We will create and connect a lead for this team.',
  save: 'Save team options', skillTerminal: 'Starting from a terminal?', skillHint: 'Only terminal setup needs an installation command. Creating a team here prepares the instructions for you.',
  history: 'Team progress', raw: 'Original message', message: 'Team update', error: 'Something went wrong. Your request is kept so retrying will not create a duplicate.',
};
const zh: typeof en = {
  title: '新建团队', start: '开始协作', goal: '你想完成什么？', goalHint: '例如：检查这个项目，组队并行修复最重要的问题，并测试修改结果。',
  project: '项目文件夹', browse: '选择文件夹', machine: '执行电脑', lead: '负责人使用', automatic: '系统会自动准备协作指引，并打开负责人的对话。在这里使用无需安装 skill。',
  options: '团队选项', name: '团队名称（选填）', model: '模型（选填）', modelHint: '留空使用该 agent 的默认模型。', members: '新成员默认使用', parallel: '同时推进的任务数', settingsHint: '对新分派的工作生效，运行中的成员保留当前配置。等待子任务的父任务不占推进名额。',
  preparing: '正在准备团队', preparingHint: '正在启动负责人并连接对话。可以离开此页，稍后从历史列表回来。',
  offline: '这台电脑当前离线，重新连接后即可启动团队。', machineRequired: '连接一台电脑，即可开始团队协作。', upgrade: '这台电脑需要新版 CLI 才能自动启动团队，请查看更新状态。', machineSettings: '查看电脑', unavailable: '当前账号尚未开放团队协作，普通对话仍可正常使用。',
  failed: '团队尚未启动成功', failedHint: '打开任务查看失败原因和恢复操作。启动结果未确认前，请勿重复创建团队。',
  open: '打开负责人对话', goalTitle: '团队目标', progress: '进展', membersTitle: '谁在做什么', result: '交付结果', inspect: '查看任务与结果',
  member: '成员', leadLabel: '负责人', starting: '正在启动', stopped: '会话已结束', unknown: '需要核实执行状态',
  waiting: '等待开始', reviewing: '等待验收', accepted: '已验收', cancelled: '已取消', working: '正在处理',
  setup: '启动这个团队', setupHint: '选择项目并描述目标，系统会为这个团队创建并连接负责人。',
  save: '保存团队选项', skillTerminal: '想从终端发起？', skillHint: '从终端使用时可查看安装命令；在这里创建团队会自动准备协作指引。',
  history: '团队进展', raw: '原始消息', message: '团队动态', error: '操作未完成，已保留请求；重试不会重复创建。',
};
export function useFirstUseCopy() { return useTranslation().lang.startsWith('zh') ? zh : en; }
