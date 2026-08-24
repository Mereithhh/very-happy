import { Link, NavLink } from 'react-router-dom';
import { CyberMark } from '@/ui/CyberMark';
import { GITHUB_URL } from './publicContent';
import './public.css';

export function PublicHeader() {
  return (
    <><a className="pub-skip" href="#main-content">Skip to content</a><header className="pub-header">
      <Link className="pub-brand" to="/welcome" aria-label="Very Happy home">
        <CyberMark size={28} />
        <span>very happy</span>
      </Link>
      <nav aria-label="Primary navigation">
        <NavLink to="/docs">Docs</NavLink>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        <a href={`${import.meta.env.BASE_URL}login`}>Sign in</a>
        <a className="pub-nav-cta" href={`${import.meta.env.BASE_URL}signup`}>Get started</a>
      </nav>
    </header></>
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
