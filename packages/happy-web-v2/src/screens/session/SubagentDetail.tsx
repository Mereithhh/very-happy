/**
 * SubagentDetail — everything one Agent/Task card knows, rendered in ONE place
 * (B-317). Both tenants use it: the drawer (`SubagentPanel`) and, when there is
 * no session route to open a drawer from, the inline tool view.
 *
 * The shape is deliberately different from the old inline dump. A sub-agent's
 * prompt is routinely 40+ lines of briefing written for a machine; rendering it
 * open, inside the transcript, pushed the actual conversation off the screen and
 * made the card read like a bug. Identity and progress are what the reader wants
 * at a glance, so those stay always-visible; the prompt is a closed disclosure.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { Markdown } from './Markdown';
import { buildSubagentSummary } from './subagentSummary';
import { presentedSubagentStatus } from './subagentAbort';
import { resultToText, toolDetail, toolLabel } from './toolInfo';
import { formatDurationMs, formatTokens } from './format';
import './subagent.css';

function Fold({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    const bodyId = useId();
    return (
        <div className="sa-fold">
            <button
                type="button"
                className="sa-fold-head vh-disclosure-trigger"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls={bodyId}
            >
                <ChevronRight size={12} className={`tg-chevron${open ? ' is-open' : ''}`} />
                <span>{label}</span>
            </button>
            <div id={bodyId} className="sa-fold-body vh-disclosure-panel" hidden={!open}>
                {open && children}
            </div>
        </div>
    );
}

export function SubagentDetail({ message, abortedAt = null }: { message: ToolCallMessage; abortedAt?: number | null }) {
    const { t } = useTranslation();
    const summary = buildSubagentSummary(message, Number.POSITIVE_INFINITY);
    const status = presentedSubagentStatus(message, abortedAt);
    const prompt = typeof message.tool.input?.prompt === 'string' ? message.tool.input.prompt : null;
    const out = resultToText(message.tool.result);
    // The log is the point of the drawer, so it is not clipped to 50 lines the
    // way the old inline card was — the drawer scrolls, the transcript doesn't.
    const logTools = summary.childTools;
    const lifecycle = summary.lifecycle;
    const facts = [
        summary.toolCount > 0 ? t('session.chat.usedTools', { count: summary.toolCount }) : null,
        lifecycle?.durationMs != null ? formatDurationMs(lifecycle.durationMs) : null,
        lifecycle?.totalTokens != null ? `${formatTokens(lifecycle.totalTokens)} tok` : null,
    ].filter((v): v is string => v !== null);

    return (
        <div className="sa">
            <div className="sa-head">
                {status && (
                    <span className={`sa-status sa-status--${status}`}>
                        {t(`session.chat.subagentStatus.${status}` as 'session.chat.subagentStatus.running')}
                    </span>
                )}
                {summary.subtype && <span className="tv-badge">{summary.subtype}</span>}
                {facts.length > 0 && <span className="sa-facts">{facts.join(' · ')}</span>}
            </div>

            {prompt && (
                <Fold label={t('session.chat.subagentPrompt')}>
                    <div className="sa-prompt vh-copyhost">
                        <pre className="sa-prompt-text">{prompt}</pre>
                        <CopyButton text={prompt} className="vh-copy--overlay" />
                    </div>
                </Fold>
            )}

            {logTools.length > 0 && (
                <div className="sa-log">
                    <div className="sa-section-label">{t('session.chat.subagentLog')}</div>
                    {logTools.map((child) => {
                        const label = toolLabel(child.tool);
                        const detail = toolDetail(child.tool);
                        const line = detail && detail !== label ? `[${label}] ${detail}` : `[${label}]`;
                        return (
                            <div
                                key={child.id}
                                className={`sa-log-line${child.tool.state === 'error' ? ' sa-log-line--error' : ''}`}
                                title={line}
                            >
                                {line}
                            </div>
                        );
                    })}
                </div>
            )}

            {lifecycle?.result && (
                <div className="sa-result">
                    <div className="sa-section-label">
                        {t('session.chat.subagentResult')}
                        {lifecycle.result.truncated ? ` · ${t('session.chat.subagentResultTruncated')}` : ''}
                    </div>
                    <Markdown text={lifecycle.result.text} />
                </div>
            )}

            {!lifecycle?.result && out.trim() && (
                <Fold label={t('tools.fullView.output')}>
                    <div className="sa-prompt vh-copyhost">
                        <pre className="sa-prompt-text">{out}</pre>
                        <CopyButton text={out} className="vh-copy--overlay" />
                    </div>
                </Fold>
            )}

            {logTools.length === 0 && !lifecycle?.result && !out.trim() && (
                <div className="sa-empty">{t('session.chat.subagentNoActivity')}</div>
            )}
        </div>
    );
}
