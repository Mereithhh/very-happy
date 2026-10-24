/**
 * BuiltinToolView — expanded card for a very-happy built-in tool call (B-499).
 *
 * Structured fields from the call's arguments, a digest of the result with
 * links into the app (session / team / task), the error when the call failed,
 * and the full raw output folded away for anyone who needs it. All content is
 * derived in `components/tools/builtinTools.ts` (pure, tested); this file only
 * lays it out.
 */
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import type { ToolCall } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { builtinToolDigest, builtinToolFields, builtinToolLabel, type BuiltinToolField, type ResolvedBuiltinTool } from '@/components/tools/builtinTools';
import { plainPreviewLines } from '@/utils/markdownPreview';
import { MessageReader, PreviewLines } from './MessageReader';
import './builtinTool.css';

function RawOutput({ text, label }: { text: string; label: string }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <div className="bt-raw">
            <button type="button" className="bt-raw-head vh-disclosure-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={id}>
                <ChevronRight size={12} className={`tg-chevron${open ? ' is-open' : ''}`} />
                <span>{label}</span>
            </button>
            <div id={id} className="vh-disclosure-panel" hidden={!open}>
                {open && (
                    <div className="tv-out vh-copyhost">
                        <pre className="tv-results">{text}</pre>
                        <CopyButton text={text} className="vh-copy--overlay vh-hit" />
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * B-716: a delegation goal, a team message / submission / return reason or a
 * cross-session body is agent markdown — the card shows plain preview lines,
 * a click opens the reader with it rendered in full.
 */
function MarkdownField({ field, tool }: { field: BuiltinToolField; tool: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const openRef = useRef<HTMLButtonElement>(null);
    const preview = plainPreviewLines(field.value, 4);
    return <>
        <button ref={openRef} type="button" className="bt-md" aria-haspopup="dialog" aria-expanded={open} aria-label={`${t('session.messageReader.open')}: ${field.label}`} onClick={() => setOpen(true)}>
            <PreviewLines {...preview} />
        </button>
        <MessageReader open={open} onOpenChange={setOpen} triggerRef={openRef} title={`${tool} · ${field.label}`} body={field.value} />
    </>;
}

export function BuiltinToolView({ resolved, tool }: { resolved: ResolvedBuiltinTool; tool: ToolCall }) {
    const { t } = useTranslation();
    const fields = builtinToolFields(resolved);
    const digest = builtinToolDigest(resolved, tool);
    const waiting = fields.length === 0 && tool.state === 'running';
    // A prose result (assistant tools answer in sentences) is the content; a
    // JSON result has been digested into lines and only stays as raw output.
    const prose = !digest.error && digest.json === null && digest.text.trim() !== '' ? digest.text.trim() : null;
    const showRaw = !digest.error && digest.json !== null && digest.text.trim() !== '';
    return (
        <div className="bt">
            {fields.length > 0 && (
                <dl className="bt-fields">
                    {fields.map((f) => (
                        <div key={f.key} className="bt-field">
                            <dt className="bt-k">{f.label}</dt>
                            <dd className={`bt-v${f.mono ? ' bt-v--mono' : ''}${f.multiline ? ' bt-v--multiline' : ''}`}>
                                {f.items ? (
                                    <ul className="bt-list">{f.items.map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                                ) : f.markdown ? <MarkdownField field={f} tool={builtinToolLabel(resolved.name)} /> : f.value}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {waiting && <div className="bt-waiting">{t('tools.builtin.waiting')}</div>}
            {digest.error && <div className="tg-error">{digest.error}</div>}
            {(digest.lines.length > 0 || digest.links.length > 0 || prose) && (
                <div className="bt-result">
                    {digest.lines.map((line, idx) => <div key={idx} className={`bt-line${idx === 0 ? ' bt-line--first' : ''}`}>{line}</div>)}
                    {prose && <div className="bt-prose">{prose}</div>}
                    {digest.links.length > 0 && (
                        <div className="bt-links">
                            {digest.links.map((link) => (
                                <Link key={link.to} to={link.to} className="bt-link" title={link.id}>
                                    {link.label}
                                    <ArrowUpRight size={13} aria-hidden />
                                </Link>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {showRaw && <RawOutput text={digest.text} label={t('tools.builtin.rawOutput')} />}
        </div>
    );
}
