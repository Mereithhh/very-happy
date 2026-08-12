/**
 * CodeView — monospace code block with optional copy button and lazy syntax
 * highlighting (shiki, loaded in its own async chunk). Falls back to plain
 * monospace text while the highlighter loads or for unsupported languages.
 */
import { useEffect, useState } from 'react';
import { CopyButton } from '@/ui/CopyButton';
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

    return (
        <div className={`cv${showLineNumbers ? ' cv--ln' : ''}`}>
            <div className="cv-bar">
                <span className="cv-lang">{lang || 'text'}</span>
                {copyable && <CopyButton text={code} showLabel className="cv-copy" />}
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
