/**
 * Shared pieces of the B-754 tool cards: the key/value table every unknown
 * tool falls back to, the search-result link list, and the collapsed
 * 「原始数据」 disclosure — the only place a call's raw JSON is shown.
 */
import { useId, useState } from 'react';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { KvRow } from '@/components/tools/toolKeyValues';
import type { LinkItem } from '@/components/tools/toolPresentation';
import { shortUrl } from '@/components/tools/toolPresentation';
import { CodeView } from './CodeView';
import './builtinTool.css';

/** Two-column field list (one column on narrow screens), same layout as the B-499 cards. */
export function KvTable({ rows, label }: { rows: KvRow[]; label?: string }) {
    const { t } = useTranslation();
    if (rows.length === 0) return null;
    return (
        <dl className="bt-fields tv-kv" aria-label={label}>
            {rows.map((row) => (
                <div key={row.key} className="bt-field">
                    <dt className="bt-k">{row.label}</dt>
                    <dd className={`bt-v${row.kind === 'mono' ? ' bt-v--mono' : ''}${row.kind === 'multiline' ? ' bt-v--multiline' : ''}${row.kind === 'summary' ? ' tv-kv-summary' : ''}`}>
                        {row.kind === 'link' ? (
                            <a className="tv-kv-link" href={row.value} target="_blank" rel="noopener noreferrer">
                                {row.value}
                                <span className="tv-sr"> ({t('tools.card.opensInNewTab')})</span>
                            </a>
                        ) : row.kind === 'list' && row.items ? (
                            <ul className="bt-list">
                                {row.items.map((item, i) => <li key={i}>{item}</li>)}
                                {row.more ? <li className="tv-kv-summary">{t('tools.card.more', { count: row.more })}</li> : null}
                            </ul>
                        ) : (
                            <>
                                {row.value}
                                {row.truncated && <span className="tv-sr"> ({t('tools.card.truncated')})</span>}
                            </>
                        )}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

export function LinkList({ links }: { links: LinkItem[] }) {
    const { t } = useTranslation();
    return (
        <ul className="tv-links" aria-label={t('tools.card.linksLabel')}>
            {links.map((link, i) => (
                <li key={`${link.url}-${i}`} className="tv-link">
                    <a href={link.url} target="_blank" rel="noopener noreferrer" className="tv-link-title">
                        <span>{link.title}</span>
                        <ArrowUpRight size={12} aria-hidden className="tv-link-cue" />
                        <span className="tv-sr"> ({t('tools.card.opensInNewTab')})</span>
                    </a>
                    <span className="tv-link-host">{shortUrl(link.url)}</span>
                    {link.snippet && <span className="tv-link-snippet">{link.snippet}</span>}
                </li>
            ))}
        </ul>
    );
}

/**
 * The call's untouched payload, folded away. `data-raw` marks it as the one
 * sanctioned JSON surface (the harness and tests check nothing else shows JSON).
 */
export function RawData({ input, result }: { input: unknown; result?: unknown }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const id = useId();
    const hasInput = input !== undefined && input !== null && !(typeof input === 'object' && Object.keys(input as object).length === 0);
    const hasResult = result !== undefined && result !== null && result !== '';
    if (!hasInput && !hasResult) return null;
    const payload = hasResult ? { input: input ?? null, result } : input;
    return (
        <div className="bt-raw" data-raw="">
            <button type="button" className="bt-raw-head vh-disclosure-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={id}>
                <ChevronRight size={12} className={`tg-chevron${open ? ' is-open' : ''}`} aria-hidden />
                <span>{t('tools.card.rawData')}</span>
            </button>
            <div id={id} className="vh-disclosure-panel" hidden={!open}>
                {open && <CodeView code={stringify(payload)} lang="json" />}
            </div>
        </div>
    );
}

function stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2) ?? '';
    } catch {
        return String(value);
    }
}
