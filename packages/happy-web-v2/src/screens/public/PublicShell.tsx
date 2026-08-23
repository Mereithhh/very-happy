import { Link, NavLink } from 'react-router-dom';
import { CyberMark } from '@/ui';
import { GITHUB_URL } from './publicContent';
import './public.css';

export function PublicHeader() {
  return (
    <header className="pub-header">
      <Link className="pub-brand" to="/" aria-label="Very Happy home">
        <CyberMark size={28} />
        <span>very happy</span>
      </Link>
      <nav aria-label="Primary navigation">
        <NavLink to="/docs">Docs</NavLink>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        <Link to="/login">Sign in</Link>
        <Link className="pub-nav-cta" to="/signup">Get started</Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="pub-footer">
      <span>Very Happy · server-trusted remote coding</span>
      <nav aria-label="Footer navigation">
        <Link to="/docs/security">Security</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <a href={GITHUB_URL}>Source</a>
      </nav>
    </footer>
  );
}
