import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Copy, Download, FileText, RefreshCw, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Markdown, NoPathLinks } from '@/screens/session/Markdown';
import { CopyButton } from './CopyButton';
import { Spinner } from './Spinner';
import { SkillDocumentBase } from './SkillDocumentLink';
import { skillDocumentBody } from './skillDocumentUrl';
import './skillDocumentPreview.css';

type DocumentState = { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error'; status?: number };

export default function SkillDocumentPreview({ url, onReady, onClose, returnFocus }: { url: string; onReady?: () => void; onClose: () => void; returnFocus: () => void }) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const titleRef = useRef<HTMLHeadingElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [navigation, setNavigation] = useState({ url, history: [] as string[] });
    const [state, setState] = useState<DocumentState>({ kind: 'loading' });
    const [attempt, setAttempt] = useState(0);
    const parsed = new URL(navigation.url);
    const path = parsed.pathname;
    const filename = path.split('/').pop() || 'SKILL.md';
    const copyLabel = zh ? '复制文档内容' : 'Copy document contents';
    const downloadLabel = zh ? '下载文档' : 'Download document';
    const closeLabel = zh ? '关闭预览' : 'Close preview';
    const backLabel = zh ? '返回上一份文档' : 'Back to previous document';

    useEffect(() => { onReady?.(); }, [onReady]);
    useEffect(() => { setState({ kind: 'loading' }); setNavigation({ url, history: [] }); }, [url]);
    const navigate = (nextUrl: string) => {
        if (nextUrl === navigation.url) return;
        setState({ kind: 'loading' });
        setNavigation(current => ({ url: nextUrl, history: [...current.history, current.url] }));
        titleRef.current?.focus({ preventScroll: true });
        bodyRef.current?.scrollTo({ top: 0 });
    };
    const download = () => {
        if (state.kind !== 'ready') return;
        const objectUrl = URL.createObjectURL(new Blob([state.text], { type: 'text/markdown;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Safari may resolve the URL after the click or after this reader closes.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    };

    useEffect(() => {
        const abort = new AbortController();
        setState({ kind: 'loading' });
        void (async () => {
            try {
                const response = await fetch(navigation.url, { signal: abort.signal, credentials: 'same-origin', redirect: 'error' });
                if (!response.ok) {
                    if (!abort.signal.aborted) setState({ kind: 'error', status: response.status });
                    return;
                }
                const text = await response.text();
                // A missing static file may be answered with the SPA shell.
                if (/text\/html/i.test(response.headers.get('content-type') ?? '') || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw Error('Not a Markdown document');
                if (!abort.signal.aborted) setState({ kind: 'ready', text });
            } catch {
                if (!abort.signal.aborted) setState({ kind: 'error' });
            }
        })();
        return () => abort.abort();
    }, [navigation.url, attempt]);

    return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="skill-preview-overlay" />
            <Dialog.Content className="skill-preview" onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
                <header className="skill-preview-head">
                    {navigation.history.length > 0 ? <button type="button" className="skill-preview-action" aria-label={backLabel} title={backLabel} onClick={() => {
                        setState({ kind: 'loading' });
                        setNavigation(current => ({ url: current.history[current.history.length - 1], history: current.history.slice(0, -1) }));
                        titleRef.current?.focus({ preventScroll: true }); bodyRef.current?.scrollTo({ top: 0 });
                    }}><ArrowLeft size={18} aria-hidden /></button> : <FileText size={18} aria-hidden />}
                    <div className="skill-preview-heading">
                        <Dialog.Title ref={titleRef} tabIndex={-1}>{zh ? 'Skill 文档' : 'Skill document'}</Dialog.Title>
                        <Dialog.Description title={path}>{path}</Dialog.Description>
                    </div>
                    <div className="skill-preview-toolbar">
                        {state.kind === 'ready' ? <CopyButton text={state.text} size={16} label={copyLabel} /> : <button type="button" className="skill-preview-action" disabled aria-label={copyLabel} title={copyLabel}><Copy size={16} aria-hidden /></button>}
                        <button type="button" className="skill-preview-action" disabled={state.kind !== 'ready'} onClick={download} aria-label={downloadLabel} title={downloadLabel}><Download size={16} aria-hidden /></button>
                        <Dialog.Close asChild><button type="button" className="skill-preview-action" aria-label={closeLabel} title={closeLabel}><X size={18} aria-hidden /></button></Dialog.Close>
                    </div>
                </header>
                <div className="skill-preview-body" ref={bodyRef}>
                    {state.kind === 'loading' && <div className="skill-preview-state"><Spinner /><span>{zh ? '正在读取文档…' : 'Loading document…'}</span></div>}
                    {state.kind === 'error' && <div className="skill-preview-state">
                        <p role="alert">{zh ? '暂时无法读取这份文档。' : 'This document could not be loaded.'}{state.status ? ` (${state.status})` : ''}</p>
                        <button type="button" className="skill-preview-action" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden />{zh ? '重试' : 'Retry'}</button>
                    </div>}
                    {state.kind === 'ready' && <SkillDocumentBase.Provider value={{ url: navigation.url, navigate }}><NoPathLinks><Markdown text={skillDocumentBody(state.text)} /></NoPathLinks></SkillDocumentBase.Provider>}
                </div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
