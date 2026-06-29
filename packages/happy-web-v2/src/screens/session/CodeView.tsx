/**
 * CodeView — monospace fenced code block with an optional copy button.
 * Used by Markdown fenced blocks and tool output rendering.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import './code.css';

export function CodeView({
    code,
    lang,
    copyable = true,
}: {
    code: string;
    lang?: string | null;
    copyable?: boolean;
}) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

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
        <div className="cv">
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
            <pre className="cv-pre">
                <code>{code}</code>
            </pre>
        </div>
    );
}
