import { ArrowRight, MessagesSquare, TerminalSquare } from 'lucide-react';
import { useId } from 'react';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';
import './mobileContinuityProof.css';

function PhoneStatus({ mode }: { mode: 'terminal' | 'conversation' }) {
  return <div className="mcp-phone-status mono" aria-hidden="true"><span>9:41</span><span>{mode === 'terminal' ? 'TERM · SOURCE' : 'CHAT · MIRROR'}</span></div>;
}

export function MobileContinuityProof({ compact = false }: { compact?: boolean }) {
  const titleId = useId();
  return <section className={`mcp${compact ? ' mcp--compact' : ''}`} aria-labelledby={titleId}>
    <header className="mcp-heading">
      <div><div className="eyebrow">STRUCTURED WHEN YOU WANT IT // NATIVE WHEN YOU NEED IT</div><h2 id={titleId}>Leave the terminal.<br /><span>Not the work.</span></h2></div>
      <p>Very Happy keeps the SDK-backed Claude experience and, where tmux is available, adds a durable terminal path where the real CLI/TUI remains the source of truth. With tmux 3.2+, optional Claude hooks connect a hand-started terminal to the structured mirror below.</p>
    </header>

    <div className="mcp-paths" aria-label="Very Happy's two Claude interaction paths">
      <div className="mcp-path-row"><span className="mono">01 · SDK PATH</span><i aria-hidden="true" /><strong>STRUCTURED SESSION</strong><small>Native SDK events</small></div>
      <div className="mcp-path-row"><span className="mono">02 · TERMINAL PATH</span><i aria-hidden="true" /><strong>REAL TUI IN TMUX</strong><b aria-hidden="true">↔</b><em>OPTIONAL CLAUDE MIRROR</em></div>
    </div>

    <div className="mcp-detail-label mono">TERMINAL PATH // OPTIONAL MIRROR DETAIL</div>
    <div className="mcp-stage">
      <article className="mcp-phone mcp-phone--terminal" aria-label="Interactive mobile terminal product preview">
        <div className="mcp-phone-shell"><div className="mcp-phone-island" aria-hidden="true" /><PhoneStatus mode="terminal" /><ProductWorkspacePreview compact initialView="terminal" initialFilesOpen={false} sidebar={false} /></div>
        <footer><span className="mono"><TerminalSquare size={13} /> REAL TUI · TMUX-BACKED</span><strong>The process stays live.</strong><small>Tap the conversation icon in the real header.</small></footer>
      </article>

      <div className="mcp-handoff" aria-hidden="true">
        <span className="mcp-handoff-ring"><MessagesSquare size={20} /></span>
        <span className="mcp-handoff-line"><i /><i /><i /></span>
        <strong className="mono">SAME CLAUDE PROCESS</strong>
        <small>OPTIONAL CLAUDE HOOKS</small>
        <ArrowRight size={18} />
      </div>

      <article className="mcp-phone mcp-phone--conversation" aria-label="Interactive mobile structured conversation product preview">
        <div className="mcp-phone-shell"><div className="mcp-phone-island" aria-hidden="true" /><PhoneStatus mode="conversation" /><ProductWorkspacePreview compact initialView="conversation" sidebar={false} /></div>
        <footer><span className="mono"><MessagesSquare size={13} /> CLAUDE · STRUCTURED MIRROR</span><strong>Read tools without reading the TUI.</strong><small>Tap “Back to terminal” whenever raw control is needed.</small></footer>
      </article>
    </div>

    <div className="mcp-foot mono"><span>01 · START IN A REAL TERMINAL</span><span>02 · FOLLOW FROM ANY SCREEN</span><span>03 · DROP BACK INTO THE SAME TUI</span></div>
  </section>;
}
