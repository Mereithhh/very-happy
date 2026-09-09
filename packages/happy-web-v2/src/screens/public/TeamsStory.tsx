import { useState } from 'react';
import { ArrowDown, ArrowRight, Check, GitBranch, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePublicI18n } from '@/i18n/publicI18n';
import './teamsStory.css';

/** An explorable example, never presented as live account activity. */
export function TeamsDiagram() {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const [selected, select] = useState(0);
  const members = zh ? [
    { role: '实现界面', agent: 'Claude Code', task: '补齐设置页面和移动端布局', result: '提交界面改动、截图与验证说明，交给负责人验收。' },
    { role: '实现接口', agent: 'Codex', task: '补齐接口并覆盖边界情况', result: '在独立 worktree 中实现接口，提交改动和测试结果。' },
    { role: '检查与验证', agent: 'pi', task: '核对行为与需求是否一致', result: '报告问题与证据；复杂任务可继续委派给下级成员。' },
  ] : [
    { role: 'Build the UI', agent: 'Claude Code', task: 'Settings screen and mobile layout', result: 'Submit changes, screenshots, and verification notes for the lead to review.' },
    { role: 'Build the API', agent: 'Codex', task: 'Endpoints and edge-case coverage', result: 'Work in an isolated worktree. Return changes and test results to the lead.' },
    { role: 'Review & verify', agent: 'pi', task: 'Check behavior against the goal', result: 'Report issues with evidence. Delegate further when a task needs its own team.' },
  ];
  const member = members[selected]!;
  return <div className="teams-map" aria-label={zh ? 'Teams 协作示意，点击成员查看分工' : 'Teams collaboration example. Select a member to explore.'}>
    <div className="teams-map-heading"><strong>Very Happy Teams</strong><span>{zh ? '交互示例' : 'Interactive example'}</span></div>
    <div className="teams-map-goal"><span>{zh ? '你说目标' : 'Your goal'}</span><p>{zh ? '“看看这个项目，把设置功能完善一下。”' : '“Explore this project and finish the settings feature.”'}</p></div>
    <div className="teams-map-stem" aria-hidden="true"><ArrowDown size={18} /></div>
    <div className="teams-map-lead"><Users size={21} /><div><strong>{zh ? '负责人' : 'Team lead'}</strong><span>{zh ? '理解目标 · 拆分任务 · 验收结果' : 'Understand · delegate · review'}</span></div><span className="teams-map-live">{zh ? '协调中' : 'Coordinating'}</span></div>
    <div className="teams-map-branches" aria-hidden="true"><i /><i /><i /></div>
    <div className="teams-map-members" aria-label={zh ? '示例成员' : 'Example members'}>{members.map((m, index) => <button type="button" key={m.agent} aria-pressed={selected === index} aria-controls="teams-member-detail" onClick={() => select(index)}><GitBranch size={16} /><strong>{m.role}</strong><span>{m.agent}</span><small>{zh ? '查看分工' : 'Explore role'} <ArrowRight size={12} /></small></button>)}</div>
    <div id="teams-member-detail" className="teams-map-detail" aria-live="polite"><span>{member.agent}</span><strong>{member.task}</strong><p>{member.result}</p></div>
    <div className="teams-map-return"><Check size={17} /><span>{zh ? '提交结果 → 负责人验收 → 完成后回收' : 'Submit → lead reviews → clean up after completion'}</span></div>
  </div>;
}

export function TeamsStory() {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  return <section className="teams-story" id="teams" aria-labelledby="teams-story-title">
    <div className="teams-story-intro">
      <header><span className="teams-story-name">Very Happy Teams</span><h2 id="teams-story-title">{zh ? '连接起来之后，让它们一起工作' : 'Connected agents. Now, a coordinated team.'}</h2><p>{zh ? '你的 coding agent hub，也是一支团队的工作区。给出目标，让负责人组织分工：独立任务并行推进，结果回到同一处验收。' : 'Your coding agent hub is also a home for coordinated work. Give a lead the goal, let members work in parallel, and bring the results back for review.'}</p><Link className="pub-button is-primary" to="/docs/agent-teams">{zh ? '开始使用 Teams' : 'Get started with Teams'} <ArrowRight size={16} /></Link><p className="teams-story-scope">{zh ? '团队当前在所选的一台电脑上执行，使用同一账号。普通对话和终端保持原样。' : 'Each team currently runs on one selected computer within your account. Regular chats and terminals stay available.'}</p></header>
      <TeamsDiagram />
    </div>
    <ol>
      <li><span>01</span><h3>{zh ? '说清要做什么' : 'Describe the work'}</h3><p>{zh ? '选择电脑和项目，创建团队；也可以让已有对话担任负责人。App 自动提供官方协作指引。' : 'Choose a computer and project, or make an existing conversation the lead. The app supplies the official collaboration instructions.'}</p></li>
      <li><span>02</span><h3>{zh ? '让任务并行起来' : 'Put agents to work'}</h3><p>{zh ? '负责人拆解目标，成员独立执行；复杂任务还可继续委派。Claude Code、Codex 和 pi 可以协作。' : 'The lead delegates, members work independently, and complex tasks can branch further. Claude Code, Codex, and pi can collaborate.'}</p></li>
      <li><span>03</span><h3>{zh ? '看进展，验结果' : 'Follow the results'}</h3><p>{zh ? '从团队打开成员对话，查看任务、提交和验收。随时用手机跟进，普通对话与终端也照常使用。' : 'Open any member conversation from the team. Follow tasks, submissions, and reviews from your phone. Regular chats and terminals stay available.'}</p></li>
    </ol>
  </section>;
}
