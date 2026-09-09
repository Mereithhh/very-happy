export type TeamSkillHost = 'claude' | 'codex' | 'pi';
export function teamSkillInstallCommand(host: TeamSkillHost) {
  return `very-happy teams install --host ${host} --apply`;
}

export function teamGettingStartedCopy(lang: string) {
  return lang.startsWith('zh') ? {
    title: '从想法到完成', bot: 'Happy Bot · 带队推进',
    steps: ['说清目标', '分工并行', '检查成果'],
    example: '检查这个仓库，组队并行修复最重要的问题，测试后汇总结果。',
    botNote: '团队协作是可选的。点击新建团队，选择项目并说清目标；普通对话照常使用。',
    teams: '新建团队', todos: 'Todo · 记下下一步',
    todoNote: '我的待办开箱即用，跟随账号同步。外部来源按需接入；记录待办不会自动派发任务。',
    openTodos: '打开待办', install: '从终端发起团队（可选）',
    host: '使用的 Agent', instruction: '从网页创建团队会自动准备协作指引，无需安装。仅从终端发起时，在执行电脑运行下方命令，再让托管会话读取命令返回的绝对路径。',
    limit: '安装不会更改 Agent 的自动发现配置。pi 请用 very-happy pi 启动；裸 pi 不会因安装 skill 获得托管能力。',
    docs: '安装、组队与定时任务教程',
  } : {
    title: 'From idea to result', bot: 'Happy Bot · Lead the work',
    steps: ['Describe the goal', 'Work in parallel', 'Review the result'],
    example: 'Inspect this repository. Form a team to fix the most important issues in parallel, then test and summarize the results.',
    botNote: 'Teams are optional. Create a team, choose a project, and describe your goal. Ordinary conversations work as before.',
    teams: 'Start a team', todos: 'Todo · Keep the next step',
    todoNote: 'My todos works immediately and syncs with your account. External sources are optional; saving a todo does not dispatch work.',
    openTodos: 'Open todos', install: 'Start from a terminal (optional)',
    host: 'Your agent', instruction: 'Teams created in the app receive collaboration instructions automatically. For terminal use only, run this command on the execution computer, then ask your managed conversation to read the returned absolute path.',
    limit: 'Installation does not change agent discovery settings. Start pi with very-happy pi; installing a skill does not attach a plain pi process.',
    docs: 'Installation, teams, and scheduled instructions',
  };
}
