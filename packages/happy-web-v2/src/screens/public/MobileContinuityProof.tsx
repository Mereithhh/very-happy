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
      <div><div className="eyebrow">ONE PROCESS // TWO LEVELS OF ATTENTION</div><h2 id={titleId}>Leave the terminal.<br /><span>Not the work.</span></h2></div>
      <p>A hand-started Claude process can keep running in the terminal while its structured mirror follows tools, results, and conversation on your phone. Tap the real controls below to move both ways.</p>
    </header>

    <div className="mcp-stage">
      <article className="mcp-phone mcp-phone--terminal" aria-label="Interactive mobile terminal product preview">
        <div className="mcp-phone-shell"><div className="mcp-phone-island" aria-hidden="true" /><PhoneStatus mode="terminal" /><ProductWorkspacePreview compact initialView="terminal" initialFilesOpen={false} sidebar={false} /></div>
        <footer><span className="mono"><TerminalSquare size={13} /> RAW TUI</span><strong>The process stays live.</strong><small>Tap the conversation icon in the real header.</small></footer>
      </article>

      <div className="mcp-handoff" aria-hidden="true">
        <span className="mcp-handoff-ring"><MessagesSquare size={20} /></span>
        <span className="mcp-handoff-line"><i /><i /><i /></span>
        <strong className="mono">SAME CLAUDE PROCESS</strong>
        <small>OPTIONAL TERMINAL HOOKS</small>
        <ArrowRight size={18} />
      </div>

      <article className="mcp-phone mcp-phone--conversation" aria-label="Interactive mobile structured conversation product preview">
        <div className="mcp-phone-shell"><div className="mcp-phone-island" aria-hidden="true" /><PhoneStatus mode="conversation" /><ProductWorkspacePreview compact initialView="conversation" sidebar={false} /></div>
        <footer><span className="mono"><MessagesSquare size={13} /> STRUCTURED VIEW</span><strong>Read tools without reading the TUI.</strong><small>Tap “Back to terminal” whenever raw control is needed.</small></footer>
      </article>
    </div>

    <div className="mcp-foot mono"><span>01 · START IN A REAL TERMINAL</span><span>02 · FOLLOW FROM ANY SCREEN</span><span>03 · DROP BACK INTO THE SAME TUI</span></div>
  </section>;
}
