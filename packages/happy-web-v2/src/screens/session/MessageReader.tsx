/**
 * MessageReader (B-716) — the full view a folded team / cross-session /
 * delegation card opens on click. Radix Dialog (like the skill document and
 * image previews): a reading surface for long agent markdown that must trap
 * focus, lock the transcript scroll, close on Esc / outside click and hand
 * focus back to the card. Desktop: centred panel; ≤600px: bottom sheet.
 *
 * The body is rendered with the transcript's own Markdown (tables, code,
 * lists, links); wide tables and code scroll inside the body, never the page.
 */
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { Markdown } from './Markdown';
import './messageReader.css';

export interface MessageReaderLink { to: string; label: string; title?: string }

export function MessageReader({ open, onOpenChange, triggerRef, icon, title, meta, body, before, links = [], raw }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** the card's open button — focus returns there on close (no Dialog.Trigger: the whole card opens it) */
    triggerRef?: RefObject<HTMLElement | null>;
    icon?: ReactNode;
    title: ReactNode;
    /** route / time / status row under the title */
    meta?: ReactNode;
    /** markdown shown in full */
    body: string;
    /** structured content above the body (paths, task line) */
    before?: ReactNode;
    links?: MessageReaderLink[];
    /** exact transport text, folded */
    raw?: string;
}) {
    const { t } = useTranslation();
    const titleRef = useRef<HTMLHeadingElement>(null);
    const [rawOpen, setRawOpen] = useState(false);
    return <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
            <Dialog.Overlay className="msg-reader-overlay" />
            <Dialog.Content
                className="msg-reader"
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus({ preventScroll: true }); }}
                onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef?.current?.focus({ preventScroll: true }); }}
            >
                <header className="msg-reader-head">
                    {icon}
                    <div className="msg-reader-heading">
                        <Dialog.Title ref={titleRef} tabIndex={-1} className="msg-reader-title">{title}</Dialog.Title>
                        {meta && <div className="msg-reader-meta">{meta}</div>}
                    </div>
                    <div className="msg-reader-toolbar">
                        <CopyButton text={body} size={16} label={t('session.messageReader.copy')} className="msg-reader-action" />
                        <Dialog.Close asChild>
                            <button type="button" className="msg-reader-action" aria-label={t('session.messageReader.close')} title={t('session.messageReader.close')}><X size={18} aria-hidden /></button>
                        </Dialog.Close>
                    </div>
                </header>
                <div className="msg-reader-body">
                    {before}
                    <Markdown text={body} />
                    {raw !== undefined && raw !== body && (
                        <div className="msg-reader-raw">
                            <button type="button" className="msg-reader-raw-toggle vh-disclosure-trigger" aria-expanded={rawOpen} onClick={() => setRawOpen((v) => !v)}>
                                <ChevronRight size={12} className={`msg-reader-chevron${rawOpen ? ' is-open' : ''}`} aria-hidden />
                                {t('session.messageReader.source')}
                            </button>
                            {rawOpen && <pre className="msg-reader-source">{raw}</pre>}
                        </div>
                    )}
                </div>
                {links.length > 0 && (
                    <footer className="msg-reader-foot">
                        {links.map((link) => (
                            <Link key={link.to} to={link.to} title={link.title} className="msg-reader-link" onClick={() => onOpenChange(false)}>
                                {link.label}<ArrowUpRight size={15} aria-hidden />
                            </Link>
                        ))}
                    </footer>
                )}
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}

/**
 * The folded preview every card shows: plain lines (no markdown syntax), at
 * most a few, faded when there is more. Pure markup; the card owns the click.
 */
export function PreviewLines({ lines, truncated, className = '' }: { lines: string[]; truncated: boolean; className?: string }) {
    if (lines.length === 0) return null;
    return <span className={`msg-preview-lines${truncated ? ' msg-preview-lines--more' : ''} ${className}`.trim()}>
        {lines.map((line, i) => <span key={i} className="msg-preview-line">{line}</span>)}
    </span>;
}
