/**
 * CodeView — monospace code block with optional copy button and lazy syntax
 * highlighting (shiki, loaded in its own async chunk). Falls back to plain
 * monospace text while the highlighter loads or for unsupported languages.
 */
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { highlightToHtml, normalizeLang } from './highlighter';
import './code.css';

export function CodeView({
    code,
    lang,
    copyable = true,
    showLineNumbers = false,
}: {
    code: string;
    lang?: string | null;
    copyable?: boolean;
    showLineNumbers?: boolean;
}) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const [html, setHtml] = useState<string | null>(null);

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

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        } catch {
            /* clipboard may be unavailable; ignore */
        }
    };

    return (
        <div className={`cv${showLineNumbers ? ' cv--ln' : ''}`}>
            <div className="cv-bar">
                <span className="cv-lang">{lang || 'text'}</span>
                {copyable && (
                    <button
                        type="button"
                        className="cv-copy"
                        onClick={onCopy}
                        aria-label={t('common.copy' as any)}
                        title={t('common.copy' as any)}
                    >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copied ? t('markdown.codeCopied' as any) : t('common.copy' as any)}</span>
                    </button>
                )}
            </div>
            {html ? (
                // shiki output: a <pre class="shiki"><code>… tree with inline
                // CSS-variable colors for light/dark. Safe — shiki escapes content.
                <div className="cv-shiki" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
                <pre className="cv-pre">
                    <code>{code}</code>
                </pre>
            )}
        </div>
    );
}
