import { ArrowRight, MessagesSquare, TerminalSquare } from 'lucide-react';
import { useId } from 'react';
import { usePublicI18n } from '../../i18n/publicI18n';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';
import './mobileContinuityProof.css';

function PhoneStatus({ mode }: { mode: 'terminal' | 'conversation' }) {
  return <div className="mcp-phone-status mono" aria-hidden="true"><span>9:41</span><span>{mode === 'terminal' ? 'TERM · SOURCE' : 'CHAT · MIRROR'}</span></div>;
}

export function MobileContinuityProof({ compact = false }: { compact?: boolean }) {
  const titleId = useId();
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  return <section className={`mcp${compact ? ' mcp--compact' : ''}`} aria-labelledby={titleId}>
    <header className="mcp-heading">
      <div><div className="eyebrow">{zh ? '想要时结构化 // 需要时回原生终端' : 'STRUCTURED WHEN YOU WANT IT // NATIVE WHEN YOU NEED IT'}</div><h2 id={titleId}>{zh ? '离开终端。' : 'Leave the terminal.'}<br /><span>{zh ? '不离开工作。' : 'Not the work.'}</span></h2></div>
      <p>{zh ? 'Very Happy 保留基于 SDK 的 Claude 体验；在可用 tmux 时，还提供以真实 CLI/TUI 为事实源的持久终端路径。tmux 3.2+ 下可选的 Claude hooks 能把手动启动的终端连到下方的结构化镜像。' : 'Very Happy keeps the SDK-backed Claude experience and, where tmux is available, adds a durable terminal path where the real CLI/TUI remains the source of truth. With tmux 3.2+, optional Claude hooks connect a hand-started terminal to the structured mirror below.'}</p>
    </header>

    <div className="mcp-paths" aria-label={zh ? 'Very Happy 的两种 Claude 交互路径' : "Very Happy's two Claude interaction paths"}>
      <div className="mcp-path-row"><span className="mono">01 · {zh ? 'SDK 路径' : 'SDK PATH'}</span><i aria-hidden="true" /><strong>{zh ? '结构化会话' : 'STRUCTURED SESSION'}</strong><small>{zh ? '原生 SDK 事件' : 'Native SDK events'}</small></div>
      <div className="mcp-path-row"><span className="mono">02 · {zh ? '终端路径' : 'TERMINAL PATH'}</span><i aria-hidden="true" /><strong>{zh ? 'TMUX 中的真实 TUI' : 'REAL TUI IN TMUX'}</strong><b aria-hidden="true">↔</b><em>{zh ? '可选 CLAUDE 镜像' : 'OPTIONAL CLAUDE MIRROR'}</em></div>
    </div>

    <div className="mcp-detail-label mono">{zh ? '终端路径 // 可选镜像细节' : 'TERMINAL PATH // OPTIONAL MIRROR DETAIL'}</div>
    <div className="mcp-stage">
      <article className="mcp-phone mcp-phone--terminal" aria-label={zh ? '可交互的移动终端产品预览' : 'Interactive mobile terminal product preview'}>
        <div className="mcp-phone-shell"><div className="mcp-phone-island" aria-hidden="true" /><PhoneStatus mode="terminal" /><ProductWorkspacePreview compact initialView="terminal" initialFilesOpen={false} sidebar={false} /></div>
        <footer><span className="mono"><TerminalSquare size={13} /> {zh ? '真实 TUI · TMUX 持久化' : 'REAL TUI · TMUX-BACKED'}</span><strong>{zh ? '进程持续运行。' : 'The process stays live.'}</strong><small>{zh ? '点击真实顶栏中的对话图标。' : 'Tap the conversation icon in the real header.'}</small></footer>
      </article>

      <div className="mcp-handoff" aria-hidden="true">
        <span className="mcp-handoff-ring"><MessagesSquare size={20} /></span>
        <span className="mcp-handoff-line"><i /><i /><i /></span>
        <strong className="mono">{zh ? '同一个 CLAUDE 进程' : 'SAME CLAUDE PROCESS'}</strong>
        <small>{zh ? '点击对话，再返回终端' : 'Tap conversation, then Back to terminal'}</small>
        <ArrowRight size={18} />
      </div>

      <article className="mcp-phone mcp-phone--conversation" aria-label={zh ? '可交互的移动结构化对话预览' : 'Interactive mobile structured conversation product preview'}>
        <div className="mcp-phone-shell"><div className="mcp-phone-island" aria-hidden="true" /><PhoneStatus mode="conversation" /><ProductWorkspacePreview compact initialView="conversation" sidebar={false} /></div>
        <footer><span className="mono"><MessagesSquare size={13} /> CLAUDE · {zh ? '结构化镜像' : 'STRUCTURED MIRROR'}</span><strong>{zh ? '不用盯着 TUI 也能读取工具进度。' : 'Read tools without reading the TUI.'}</strong><small>{zh ? '需要原始控制时，随时点击“返回终端”。' : 'Tap “Back to terminal” whenever raw control is needed.'}</small></footer>
      </article>
    </div>

    <div className="mcp-foot mono"><span>01 · {zh ? '从真实终端开始' : 'START IN A REAL TERMINAL'}</span><span>02 · {zh ? '在任何屏幕跟进' : 'FOLLOW FROM ANY SCREEN'}</span><span>03 · {zh ? '回到同一个 TUI' : 'DROP BACK INTO THE SAME TUI'}</span></div>
  </section>;
}
