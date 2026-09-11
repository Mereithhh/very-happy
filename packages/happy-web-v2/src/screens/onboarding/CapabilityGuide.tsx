import { Link } from 'react-router-dom';
import { MonitorSmartphone, TerminalSquare, FolderOpen, ArrowRight } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Command } from './ConnectMachineGuide';
import { SkillDocumentLink } from '@/ui/SkillDocumentLink';
import './capabilityGuide.css';

/** Shared by first-run and the persistent help page: describe shipped paths only. */
export function MachineWorkflowGuide() {
  const { lang } = useTranslation();
  const zh = lang.startsWith('zh');
  const steps = zh ? [
    ['连接电脑，手机接着用', '在有项目的电脑安装 CLI、登录同一账号并启动 daemon。电脑保持在线，手机和其他浏览器就能接续会话；可连接多台电脑。', '/machine/connect', '连接新机器'],
    ['对话、终端，按工作选择', '按电脑已安装能力选择 Claude Code、Codex、pi 等 Agent。新建会话中选择普通对话或网页终端，也能接入已有 tmux、导入 Claude Code 历史。终端与对话视图按会话能力切换。', '/docs/quickstart', '查看开始方式'],
    ['让成果留在工作区', '右上角文件入口浏览执行电脑的目录、查看代码和改动；笔记、待办与团队帮助你记录下一步并跟进成果。', '/docs/architecture', '浏览完整能力'],
  ] : [
    ['Connect a computer. Continue on your phone.', 'Install the CLI on the computer with your project, sign in to the same account and start the daemon. Keep it online to continue from your phone or another browser. Connect more than one computer.', '/machine/connect', 'Connect a machine'],
    ['Choose chat or a terminal', 'Choose an installed agent such as Claude Code, Codex or pi. New session offers chat, a web terminal, existing tmux sessions and Claude Code history import. Switch between terminal and conversation views where the session supports it.', '/docs/quickstart', 'Ways to get started'],
    ['Keep the work within reach', 'Open Files in the chat header to browse the execution computer, preview code and inspect changes. Notes, todos and teams help you track the next step and review results.', '/docs/architecture', 'Explore the capabilities'],
  ];
  const icons = [MonitorSmartphone, TerminalSquare, FolderOpen];
  return <section className="cap-guide" aria-label={zh ? 'Very Happy 能做什么' : 'What Very Happy can do'}>
    <h2>{zh ? '你的电脑运行 Agent，你在哪里都能接续' : 'Your computers run the agents. You can work from anywhere.'}</h2>
    <div className="cap-guide__steps">{steps.map(([title, description, to, action], index) => {
      const Icon = icons[index];
      return <article key={to}><Icon size={20} aria-hidden /><h3>{title}</h3><p>{description}</p><Link to={to}>{action}<ArrowRight size={14}/></Link></article>;
    })}</div>
    <p className="cap-guide__note">{zh ? 'Agent 和文件操作运行在你选择的电脑上，网页通过 relay 连接它。手机不用安装 Agent；执行电脑离线时，无法启动或接续执行。团队目前在单账号的一台执行电脑内协作。' : 'Agents and file operations run on the computer you select; the web app connects through a relay. Your phone needs no agent installation. Execution requires the computer to be online. A team currently works within one account and one execution computer.'}</p>
  </section>;
}

export function AgentSkillsGuide() {
  const { lang } = useTranslation();
  const zh = lang.startsWith('zh');
  return <section className="cap-guide" aria-labelledby="cap-skills-title">
    <h2 id="cap-skills-title">{zh ? '把 Very Happy 的能力交给你的 Agent' : 'Give your agent the Very Happy instructions'}</h2>
    <p>{zh ? '官方 skills 说明如何操作团队、待办与外部来源。按需要阅读或安装，不必全部配置后才能开始聊天。' : 'Official skills explain teams, todos and external providers. Read or install what you need; none is a prerequisite for ordinary chat.'}</p>
    <div className="cap-guide__skills">
      <article><h3>{zh ? '团队协作 skill' : 'Teams skill'}</h3><p>{zh ? '网页创建团队会自动准备协作指引。从终端发起时，展开上方“从终端发起团队”，选择 Claude Code、Codex 或 pi，复制安装命令。让托管会话读取安装返回的绝对路径；安装本身不会自动接管终端或修改宿主的 skill 发现目录。' : 'The app prepares team instructions automatically. For terminal use, expand “Start from a terminal” above, select Claude Code, Codex or pi, and copy the install command. Have the managed conversation read the returned path. Installation does not attach a terminal or modify host skill discovery.'}</p><a href="#team-skill-install" onClick={() => { const panel = document.getElementById('team-skill-install'); if (panel instanceof HTMLDetailsElement) panel.open = true; }}>{zh ? '选择 Agent 并查看安装命令' : 'Choose an agent and get the install command'}<ArrowRight size={14}/></a><br/><Link to="/docs/agent-teams">{zh ? '团队安装与使用教程' : 'Teams installation guide'}<ArrowRight size={14}/></Link></article>
      <article><h3>{zh ? '让 AI 使用我的待办' : 'Let AI use my todos'}</h3><p>{zh ? '在“待办 → 我的待办”点击“让 AI 使用我的待办”，复制完整指引给 Agent；也可在已连接的电脑运行下方命令。请让 Agent 使用同一个账号和 server，先读取现有待办。' : 'In Todos → My todos, choose “Let AI use my todos” and paste the instructions into your agent, or run this command on your connected computer. Use the same account and server, and read existing todos first.'}</p><Command value="very-happy todo skill"/><Link to="/todos">{zh ? '打开待办并复制 skill' : 'Open todos and copy the skill'}<ArrowRight size={14}/></Link></article>
      <article><h3>{zh ? '接入自己的待办来源' : 'Connect a todo provider'}</h3><p>{zh ? '如果已有外部任务系统，可以让 Agent 阅读 provider skill，协助配置来源。它与内置待办独立；是否支持你的服务，需要按文档核对，读取 skill 不会自动获得账号权限。' : 'If you use an external task system, give your agent the provider skill to help configure a source. Providers are separate from built-in todos. Check service compatibility; reading a skill grants no account access.'}</p><SkillDocumentLink href="/skills/very-happy-todo-provider/SKILL.md">{zh ? '打开 provider skill' : 'Open provider skill'}<ArrowRight size={14}/></SkillDocumentLink></article>
    </div>
  </section>;
}
