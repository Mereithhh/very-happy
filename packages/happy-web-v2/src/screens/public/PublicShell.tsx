import { Link, NavLink } from 'react-router-dom';
import { BrandIcon, BrandEnvBadge } from '@/ui/BrandMark';
import { BRAND } from '@/app/brand';
import { QuickThemeToggle } from '@/ui/QuickThemeToggle';
import { GITHUB_URL } from './publicContent';
import { EXTERNAL_LINK } from '@/app/attribution';
import { CreditLine } from '@/ui/CreditLine';
import { usePublicI18n } from '@/i18n/publicI18n';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import './public.css';

/** Same check main.tsx uses to pick the root: this browser holds an account. */
export function hasStoredAccount(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try { return Boolean(storage?.getItem('auth_credentials')); } catch { return false; }
}

export function PublicHeader() {
  const { copy } = usePublicI18n();
  // B-728 (UI-P1-13): signed in (/whats-new, /docs, /welcome with an account) → one
  // way back into the workspace instead of 登录 / 开始使用.
  const signedIn = hasStoredAccount();
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
        <a className="pub-nav-secondary" href={GITHUB_URL} {...EXTERNAL_LINK}>GitHub</a>
        {!signedIn && <a className="pub-nav-login" href={`${import.meta.env.BASE_URL}login`}>{copy.shell.signIn}</a>}
        <QuickThemeToggle className="pub-theme-toggle" labels={{ light: copy.shell.switchToLight, dark: copy.shell.switchToDark }} />
        {signedIn
          ? <a className="pub-nav-cta" href={import.meta.env.BASE_URL}>{copy.shell.openApp}</a>
          : <a className="pub-nav-cta" href={`${import.meta.env.BASE_URL}login`}>{copy.shell.getStarted}</a>}
      </nav>
    </header></>
  );
}

export function PublicFooter() {
  const { copy } = usePublicI18n();
  return (
    <footer className="pub-footer">
      <div className="pub-footer-brand">
        <span>{copy.shell.footerTagline}</span>
        <CreditLine where="public-footer" className="pub-credit" builtBy={copy.shell.builtBy} sourceLabel={copy.shell.sourceOnGitHub} />
      </div>
      <nav aria-label={copy.shell.footerLabel}>
        <Link to="/docs/security">{copy.shell.security}</Link>
        <Link to="/privacy">{copy.shell.privacy}</Link>
        <Link to="/terms">{copy.shell.terms}</Link>
        <a href={GITHUB_URL} {...EXTERNAL_LINK}>{copy.shell.source}</a>
      </nav>
    </footer>
  );
}
