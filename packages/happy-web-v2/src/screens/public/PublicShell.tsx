import { Link, NavLink } from 'react-router-dom';
import { BrandIcon, BrandEnvBadge } from '@/ui/BrandMark';
import { BRAND } from '@/app/brand';
import { QuickThemeToggle } from '@/ui/QuickThemeToggle';
import { GITHUB_URL } from './publicContent';
import { usePublicI18n } from '@/i18n/publicI18n';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import './public.css';

export function PublicHeader() {
  const { copy } = usePublicI18n();
  return (
    <><a className="pub-skip" href="#main-content">{copy.shell.skip}</a><header className="pub-header">
      <Link className="pub-brand" to="/welcome" aria-label={copy.shell.homeLabel}>
        {BRAND.wordmarkUrl
          ? <img className="pub-brand-lockup" src={BRAND.wordmarkUrl} alt={BRAND.name} style={{ height: 28, width: 'auto' }} />
          : <><BrandIcon size={28} /><span>{BRAND.wordmark}</span></>}
        <BrandEnvBadge />
      </Link>
      <nav aria-label={copy.shell.navLabel}>
        <LanguageSwitcher />
        <NavLink className="pub-nav-secondary" to="/docs">{copy.shell.docs}</NavLink>
        <a className="pub-nav-secondary" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        <a className="pub-nav-login" href={`${import.meta.env.BASE_URL}login`}>{copy.shell.signIn}</a>
        <QuickThemeToggle className="pub-theme-toggle" />
        <a className="pub-nav-cta" href={`${import.meta.env.BASE_URL}login`}>{copy.shell.getStarted}</a>
      </nav>
    </header></>
  );
}

export function PublicFooter() {
  const { copy } = usePublicI18n();
  return (
    <footer className="pub-footer">
      <span>{copy.shell.footerTagline}</span>
      <nav aria-label={copy.shell.footerLabel}>
        <Link to="/docs/security">{copy.shell.security}</Link>
        <Link to="/privacy">{copy.shell.privacy}</Link>
        <Link to="/terms">{copy.shell.terms}</Link>
        <a href={GITHUB_URL}>{copy.shell.source}</a>
      </nav>
    </footer>
  );
}
