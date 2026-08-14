/**
 * CodeView — monospace code block with optional copy button and lazy syntax
 * highlighting (shiki, loaded in its own async chunk). Falls back to plain
 * monospace text while the highlighter loads or for unsupported languages.
 *
 * Long blocks COLLAPSE instead of clipping (B-097): past ~23 visible lines the
 * block truncates at the 420px cap with a bottom fade and an explicit
 * "show all (N lines)" toggle. overflow-y stays hidden on purpose (fb44581f):
 * the wheel must bubble to the transcript, never a nested scroll area.
 * File-preview surfaces pass `collapsible={false}` and render in full.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { countLines, shouldCollapseCode } from './codeCollapse';
import { highlightToHtml, normalizeLang } from './highlighter';
import './code.css';

export function CodeView({
    code,
    lang,
    copyable = true,
    showLineNumbers = false,
    collapsible = true,
}: {
    code: string;
    lang?: string | null;
    copyable?: boolean;
    showLineNumbers?: boolean;
    /** File viewers (own scroll surface) disable transcript-style collapsing. */
    collapsible?: boolean;
}) {
    const { t } = useTranslation();
    const [html, setHtml] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setHtml(null);
        if (!normalizeLang(lang)) return;
        // Skip highlighting very large blobs to stay responsive.
        if (code.length > 100_000) return;
        highlightToHtml(code, lang ?? null).then((res) => {
            if (!cancelled && res) setHtml(res.html);
        });
        return () => {
            cancelled = true;
        };
    }, [code, lang]);

    const lineCount = countLines(code);
    const canCollapse = collapsible && shouldCollapseCode(lineCount);
    const collapsed = canCollapse && !expanded;

    return (
        <div className={`cv${showLineNumbers ? ' cv--ln' : ''}${collapsed ? ' cv--collapsed' : ''}`}>
            <div className="cv-bar">
                <span className="cv-lang">{lang || 'text'}</span>
                {copyable && <CopyButton text={code} showLabel className="cv-copy" />}
            </div>
            <div className="cv-body">
                {html ? (
                    // shiki output: a <pre class="shiki"><code>… tree with inline
                    // CSS-variable colors for light/dark. Safe — shiki escapes content.
                    <div className="cv-shiki" dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                    <pre className="cv-pre">
                        <code>{code}</code>
                    </pre>
                )}
                {collapsed && <div className="cv-fade" aria-hidden />}
            </div>
            {canCollapse && (
                <button
                    type="button"
                    className="cv-expand"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={!collapsed}
                >
                    {collapsed
                        ? t('session.chat.expandLines', { lines: lineCount })
                        : t('session.chat.collapseLines')}
                </button>
            )}
        </div>
    );
}
