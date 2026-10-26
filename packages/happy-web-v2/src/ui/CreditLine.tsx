import type { ReactNode } from 'react';
import { Github } from 'lucide-react';
import { AUTHOR_URL, EXTERNAL_LINK, REPO_URL } from '@/app/attribution';
import './creditLine.css';

/**
 * 「由 Mereithhh（JoJo）开发 · GitHub」 — the author credit shared by the public footers, the share
 * page and login. Labels come from the caller (public pages use publicI18n, the app uses
 * t()), so this file pulls in neither. `lead` goes first (the share page's 「Made with Very Happy」).
 * `where` names the placement for screenshots / tests (`data-credit`).
 */
export function CreditLine({ builtBy, sourceLabel, lead, where, className }: {
  builtBy: string;
  /** accessible name of the GitHub link (its visible text is always 「GitHub」) */
  sourceLabel: string;
  lead?: ReactNode;
  where: string;
  className?: string;
}) {
  return (
    <p className={['vh-credit', className].filter(Boolean).join(' ')} data-credit={where}>
      {lead && <>{lead}<span className="vh-credit__sep" aria-hidden>·</span></>}
      <a href={AUTHOR_URL} {...EXTERNAL_LINK}>{builtBy}</a>
      <span className="vh-credit__sep" aria-hidden>·</span>
      <a href={REPO_URL} {...EXTERNAL_LINK} aria-label={sourceLabel}><Github size={13} aria-hidden />GitHub</a>
    </p>
  );
}
