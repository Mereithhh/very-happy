/** DEV-only visual harness for the real mobile terminal Web keyboard. */
import { useState } from 'react';
import { TermWebKeyboard } from '@/screens/terminal/TermWebKeyboard';
import '@/screens/terminal/terminal.css';

function visibleBytes(value: string): string {
  return [...value].map((character) => {
    if (character === '\r') return '<CR>';
    if (character === '\x7f') return '<DEL>';
    if (character === ' ') return '<SPACE>';
    const code = character.charCodeAt(0);
    if (code < 32) return `<0x${code.toString(16).padStart(2, '0')}>`;
    return character;
  }).join(' ');
}

export function TerminalKeyboardHarness() {
  const [open, setOpen] = useState(true);
  const [bytes, setBytes] = useState('');
  const emit = (next: string) => setBytes((current) => current + next);

  return (
    <main className="term-screen" data-testid="terminal-keyboard-harness">
      <header className="term-header">
        <strong className="term-title">Terminal keyboard · mobile QA</strong>
      </header>
      <section className="term-host" aria-label="Terminal fixture">
        <pre
          data-testid="pty-output"
          style={{ margin: 0, color: 'var(--term-chrome-fg)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {visibleBytes(bytes) || 'Tap keys to inspect emitted PTY bytes.'}
        </pre>
      </section>
      <div className="term-bottombars">
        <div className="term-keybar" role="toolbar" aria-label="Terminal keys">
          <button
            type="button"
            className="term-keybar-key term-keybar-wide"
            aria-label="Enter shortcut"
            onClick={() => emit('\r')}
          >
            Enter
          </button>
          <button
            type="button"
            className={`term-keybar-key term-keybar-sys${open ? ' is-armed' : ''}`}
            aria-pressed={open}
            onClick={() => setOpen((value) => !value)}
          >
            WEB
          </button>
          <button
            type="button"
            className="term-keybar-key term-keybar-sys"
            onClick={() => setOpen(false)}
          >
            SYSTEM
          </button>
          <button type="button" className="term-keybar-key" onClick={() => setBytes('')}>Clear</button>
        </div>
        {open && <TermWebKeyboard onBytes={emit} />}
      </div>
    </main>
  );
}
