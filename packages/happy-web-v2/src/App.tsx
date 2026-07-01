import { useEffect, useState } from 'react';
import './App.css';

type Theme = 'system' | 'dark' | 'light';

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
}

/**
 * P0 placeholder: a design-system showcase that proves the Console tokens
 * render correctly (signature status line + caret, buttons, badges, mono chips,
 * both themes). The real router/app shell lands in P2.
 */
export function App() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="page">
      <div className="backdrop" aria-hidden />

      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden />
          <span className="wordmark">very happy</span>
          <span className="eyebrow">web v2 · P0</span>
        </div>
        <div className="theme-switch" role="group" aria-label="theme">
          {(['system', 'dark', 'light'] as Theme[]).map((t) => (
            <button
              key={t}
              className={t === theme ? 'seg seg-on' : 'seg'}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </header>

      <main className="content">
        {/* signature: status line + caret */}
        <section className="card">
          <div className="eyebrow">signature · status line</div>
          <div className="statusline mono">
            <span>mac-office</span>
            <span className="sep">·</span>
            <span>~/code/very-happy</span>
            <span className="sep">·</span>
            <span className="k">opus-4.8</span>
            <span className="sep">·</span>
            <span>effort:high</span>
            <span className="sep">·</span>
            <span className="live">● connected</span>
            <span className="caret" aria-hidden />
          </div>
        </section>

        {/* buttons */}
        <section className="card">
          <div className="eyebrow">buttons</div>
          <div className="row">
            <button className="btn btn-primary">Primary</button>
            <button className="btn btn-secondary">Secondary</button>
            <button className="btn btn-ghost">Ghost</button>
            <button className="btn btn-danger">Danger</button>
            <button className="btn btn-primary" disabled>
              Disabled
            </button>
            <button className="btn btn-primary btn-loading">
              <span className="spinner" aria-hidden /> Loading
            </button>
          </div>
        </section>

        {/* badges + chips */}
        <section className="card">
          <div className="eyebrow">status · badges + mono chips</div>
          <div className="row">
            <span className="badge badge-live">
              <span className="dot" /> live
            </span>
            <span className="badge badge-warn">
              <span className="dot" /> warn
            </span>
            <span className="badge badge-err">
              <span className="dot" /> error
            </span>
            <span className="badge badge-muted">
              <span className="dot" /> muted
            </span>
            <span className="chip mono">
              <span className="chip-k">model</span> opus-4.8
            </span>
            <span className="chip mono">
              <span className="chip-k">cwd</span> ~/code
            </span>
          </div>
        </section>

        {/* input / composer */}
        <section className="card">
          <div className="eyebrow">input</div>
          <input className="input" placeholder="Type something…" />
        </section>

        <p className="footnote mono">
          tokens: happy/references/very-happy-design-tokens.md · accent = live only
        </p>
      </main>
    </div>
  );
}
