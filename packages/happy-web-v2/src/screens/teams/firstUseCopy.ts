import { useTranslation } from '@/i18n/useTranslation';
const en = {
  launchFailed: 'Startup needs attention', retryHint: 'The computer relaunches automatically a few times with backoff. If it still fails, fix the cause and choose Retry launch. Sending a message does not restart the agent.', unknownHint: 'The launch outcome is unconfirmed, so the computer will not relaunch on its own. After confirming the old process has stopped, retry the launch or cancel the task.', retryLaunch: 'Retry launch', retryConfirm: 'I confirmed the previous launch process has stopped', retryRequested: 'Retry requested', retryUpgrade: 'Update the CLI on this computer to retry from here; until then, cancel and reassign the task.', configure: 'Computer, folder and agent', chatIntro: 'Describe the goal. Your lead will organize the work and continue in chat.', title: 'Start a team', start: 'Start working', goal: 'What would you like done?', goalHint: 'For example: review this project, fix the most important issues in parallel, and test the changes.', goalNote: 'Just tell the lead what you need. It splits the work, creates members as needed and reviews their results.',
  project: 'Working folder', teamProject: 'Project', teamProjectNone: 'No project', teamProjectHint: 'Team members share this project’s instructions and log.', needGoal: 'Describe the goal first', needDirectory: 'Choose a working folder first', browse: 'Choose folder', machine: 'Machine', lead: 'Team lead', automatic: 'New teams run without per-tool approvals by default; you can change this in team settings. We prepare the collaboration instructions and open the lead’s conversation.',
  options: 'Team options', name: 'Team name (optional)', model: 'Default model', modelHint: 'Leave blank to use this agent’s default.', members: 'New members', parallel: 'Tasks progressing at once', settingsHint: 'Applies to new assignments. Running members keep their current configuration. Parents waiting for children do not occupy a work slot.',
  preparing: 'Preparing your team', preparingHint: 'Starting the lead and connecting its conversation. You can leave this page and return from your history.',
  offline: 'This computer is offline. Reconnect it to start a team.', machineRequired: 'Connect a computer to start a team.', upgrade: 'This computer needs a newer CLI to start teams automatically. Check its update status.', machineSettings: 'View computer', unavailable: 'Team collaboration is unavailable for this account. Ordinary conversations still work.',
  failed: 'The team could not start', failedHint: 'Open the task to inspect the failure and recovery options. Do not create another team while the previous launch is uncertain.',
  open: 'Open lead conversation', goalTitle: 'Team goal', progress: 'Progress', membersTitle: 'Who is working', result: 'Delivered result', inspect: 'View task and result',
  adoptTitle: 'Start a team from this conversation', member: 'Member', memberPlaceholder: 'Member name (optional)', leadLabel: 'Lead', starting: 'Starting', stopped: 'Session ended', unknown: 'Check execution',
  waiting: 'Waiting to start', reviewing: 'Ready for review', accepted: 'Accepted', cancelled: 'Cancelled', working: 'Working on',
  setup: 'Start this team', setupHint: 'Choose a working folder and describe the goal. We will create and connect a lead for this team.',
  save: 'Save team options', skillTerminal: 'Starting from a terminal?', skillHint: 'Only terminal setup needs an installation command. Creating a team here prepares the instructions for you.',
  history: 'Team progress', raw: 'Original message', message: 'Team update', error: 'Something went wrong. Your request is kept so retrying will not create a duplicate.',
  modelDefault: 'Follow the agent default', modelCustom: 'custom (this computer)', modelNotListed: 'not in this computer’s list',
  modelNotListedHint: 'The saved model is not in this harness’s list on this computer. It is kept; pick another one if members fail to start.',
  harnessUnavailable: 'not installed', harnessUnavailableHint: 'This harness is not available on the team’s computer; new members will fail to start until it is installed.',
  leadAndMembers: 'Agent (lead and new members)',
};
const zh: typeof en = {
  launchFailed: '启动需处理', retryHint: '电脑会按退避自动重试几次；仍失败时，修复原因后点「重试启动」。发送消息不会重新启动 agent。', unknownHint: '启动结果未确认，电脑不会自动重试。确认旧进程已停止后，可重试启动或取消任务。', retryLaunch: '重试启动', retryConfirm: '我已确认上一次启动的进程已停止', retryRequested: '已请求重试', retryUpgrade: '这台电脑的 CLI 更新后才能在这里重试；在此之前请取消任务并重新分派。', configure: '电脑、目录与 Agent', chatIntro: '说说你想完成什么，负责人会组织工作，并在对话中继续。', title: '新建团队', start: '开始协作', goal: '你想完成什么？', goalHint: '例如：检查这个项目，组队并行修复最重要的问题，并测试修改结果。', goalNote: '你只需要告诉负责人要做什么，它会自己拆分任务、按需创建成员并验收结果。',
  project: '工作目录', teamProject: '所属项目', teamProjectNone: '不放进项目', teamProjectHint: '团队成员共享这个项目的说明和记录。', needGoal: '先写目标', needDirectory: '先选工作目录', browse: '选择文件夹', machine: '机器', lead: '负责人使用', automatic: '新建团队默认免审批执行，可在团队设置中调整。系统会准备协作指引，并打开负责人的对话。',
  options: '团队选项', name: '团队名称（选填）', model: '默认模型', modelHint: '留空使用该 agent 的默认模型。', members: '新成员默认使用', parallel: '同时推进的任务数', settingsHint: '对新分派的工作生效，运行中的成员保留当前配置。等待子任务的父任务不占推进名额。',
  preparing: '正在准备团队', preparingHint: '正在启动负责人并连接对话。可以离开此页，稍后从历史列表回来。',
  offline: '这台电脑当前离线，重新连接后即可启动团队。', machineRequired: '连接一台电脑，即可开始团队协作。', upgrade: '这台电脑需要新版 CLI 才能自动启动团队，请查看更新状态。', machineSettings: '查看电脑', unavailable: '当前账号尚未开放团队协作，普通对话仍可正常使用。',
  failed: '团队尚未启动成功', failedHint: '打开任务查看失败原因和恢复操作。启动结果未确认前，请勿重复创建团队。',
  open: '打开负责人对话', goalTitle: '团队目标', progress: '进展', membersTitle: '谁在做什么', result: '交付结果', inspect: '查看任务与结果',
  adoptTitle: '用这个对话组建团队', member: '成员', memberPlaceholder: '成员名称（选填）', leadLabel: '负责人', starting: '正在启动', stopped: '会话已结束', unknown: '需要核实执行状态',
  waiting: '等待开始', reviewing: '等待验收', accepted: '已验收', cancelled: '已取消', working: '正在处理',
  setup: '启动这个团队', setupHint: '选择工作目录并描述目标，系统会为这个团队创建并连接负责人。',
  save: '保存团队选项', skillTerminal: '想从终端发起？', skillHint: '从终端使用时可查看安装命令；在这里创建团队会自动准备协作指引。',
  history: '团队进展', raw: '原始消息', message: '团队动态', error: '操作未完成，已保留请求；重试不会重复创建。',
  modelDefault: '跟随执行 Agent 的默认模型', modelCustom: '自定义（这台电脑）', modelNotListed: '不在这台电脑的列表里',
  modelNotListedHint: '已保存的模型不在这台电脑上该执行 Agent 的模型列表里。仍会保留；如果成员启动失败，换一个模型。',
  harnessUnavailable: '未安装', harnessUnavailableHint: '团队所在机器上没有这个执行 Agent，装好之前新成员会启动失败。',
  leadAndMembers: '执行 Agent（负责人和新成员）',
};
/** Both languages, for tests (B-759). */
export const FIRST_USE_COPY = { en, zh };
export function useFirstUseCopy() { return useTranslation().lang.startsWith('zh') ? zh : en; }
