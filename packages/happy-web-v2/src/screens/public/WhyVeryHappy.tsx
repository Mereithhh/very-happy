import { ArrowRight } from 'lucide-react';
import { usePublicI18n } from '../../i18n/publicI18n';
import './whyVeryHappy.css';

const VALUE_ROUTES = [
  {
    friction: 'Agents and terminals are scattered across several machines.',
    title: 'One panel holds the fleet.',
    outcome: 'Sessions, status, tasks, and attention state gather around the machine and agent you choose.',
  },
  {
    friction: 'Structured chat is pleasant—until the actual tool needs your hands.',
    title: 'Structured when useful. Native when necessary.',
    outcome: 'Follow the readable conversation, then step into the same durable TTY when raw control matters.',
  },
  {
    friction: 'Leaving the desk makes active work difficult to follow.',
    title: 'Carry the work between screens.',
    outcome: 'The responsive Web and PWA keep conversations, terminals, files, and decisions within reach.',
  },
  {
    friction: 'Remote control has to fit your operating model.',
    title: 'Choose the operator—not another silo.',
    outcome: 'Start with Very Happy Cloud or run the same open-source stack with your own policy and storage.',
  },
] as const;

const VALUE_ROUTES_ZH = [
  { friction: '多台机器上的 Agent 与终端四处分散。', title: '一个面板掌握整个机器群', outcome: '会话、状态、任务与待处理事项，都围绕你选择的机器和 Agent 集中呈现。' },
  { friction: '结构化对话很顺手——直到真正的工具需要你亲自操作。', title: '适合时用结构化界面，必要时回到原生终端', outcome: '先跟进清晰的对话，需要原始控制时，再进入同一个持久 TTY。' },
  { friction: '离开桌面后，正在运行的工作很难继续跟进。', title: '让工作跟着你切换屏幕', outcome: '响应式 Web 与 PWA 让对话、终端、文件和决策随时可达。' },
  { friction: '远程控制必须适配你的运营方式。', title: '选择运营方，而不是再进一个孤岛', outcome: '可以从 Very Happy Cloud 开始，也可以用自己的策略与存储运行同一套开源系统。' },
] as const;

export function WhyVeryHappy() {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const routes = zh ? VALUE_ROUTES_ZH : VALUE_ROUTES;
  return <section className="why-vh" aria-labelledby="why-vh-title">
    <header className="why-vh-head">
      <div>
        <div className="eyebrow">{zh ? '为什么选择 VERY HAPPY // 协作开销收口' : 'WHY VERY HAPPY // OVERHEAD ROUTING'}</div>
        <h2 id="why-vh-title">{zh ? '工作已经够复杂' : 'The work is already complex.'}<br /><span>{zh ? '界面不该再添麻烦' : "The interface shouldn't add to it."}</span></h2>
      </div>
      <p>{zh ? 'Very Happy 不会取代已经好用的机器和工具，它只负责承接它们之间的协作开销。' : 'Very Happy does not replace the machines and tools that already work. It carries the coordination overhead between them.'}</p>
    </header>

    <div className="why-vh-routes" role="list" aria-label={zh ? 'Very Happy 代为承担的繁琐工作' : 'Friction carried by Very Happy'}>
      {routes.map((route, index) => <article className="why-vh-route" role="listitem" key={route.title}>
        <div className="why-vh-friction">
          <span className="mono">{zh ? '阻力' : 'FRICTION'} {String(index + 1).padStart(2, '0')}</span>
          <p>{route.friction}</p>
        </div>
        <div className="why-vh-signal" aria-hidden="true">
          <span className="why-vh-signal-origin" />
          <span className="why-vh-signal-line"><i /></span>
          <ArrowRight size={17} />
        </div>
        <div className="why-vh-outcome">
          <span className="mono">{zh ? 'VERY HAPPY 负责承接' : 'CARRIED BY VERY HAPPY'}</span>
          <h3>{route.title}</h3>
          <p>{route.outcome}</p>
        </div>
      </article>)}
    </div>
    <div className="why-vh-foot mono"><span>{zh ? '保留原有工具' : 'KEEP THE TOOLS'}</span><span>{zh ? '告别反复巡视' : 'LOSE THE PATROL WORK'}</span><strong>{zh ? '人始终掌控' : 'HUMAN IN CONTROL'}</strong></div>
  </section>;
}
