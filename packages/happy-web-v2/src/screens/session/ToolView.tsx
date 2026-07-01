/**
 * ToolView — specialized per-tool rendering for an expanded tool call.
 * Dispatches on tool name to a purpose-built view; everything unrecognized
 * (including the long tail of MCP tools) gets an attractive default with a
 * collapsible pretty-printed input + output rather than a raw JSON blob.
 */
import { useState, type ReactNode } from 'react';
import { CheckSquare, ChevronRight, Circle, Globe, Search, Square } from 'lucide-react';
import type { ToolCallMessage, ToolCall, Message } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { useSetting } from '@/sync/storage';
import { trimIdent } from '@/utils/trimIdent';
import { CommandView } from './CommandView';
import { CodeView } from './CodeView';
import { DiffView } from './DiffView';
import { asCommand, extractError, resultToText } from './toolInfo';
import { langForPath } from './langForPath';
import './toolview.css';

function asString(v: unknown): string | null {
    return typeof v === 'string' ? v : null;
}

// Collapsible labelled section used by the default / search / web views.
function Section({ label, children, defaultOpen = true }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="tv-section">
            <button type="button" className="tv-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                <ChevronRight size={12} className={`tg-chevron${open ? ' is-open' : ''}`} />
                <span>{label}</span>
            </button>
            {open && <div className="tv-section-body">{children}</div>}
        </div>
    );
}

// ── Bash ───────────────────────────────────────────────────────────────────
function BashView({ tool }: { tool: ToolCall }) {
    const cmd = asCommand(tool);
    if (!cmd) return <DefaultView tool={tool} />;
    return <CommandView command={cmd.command} stdout={cmd.stdout} stderr={cmd.stderr} error={cmd.error} />;
}

// ── Edit / MultiEdit / Write (diff) ──────────────────────────────────────────
function EditView({ tool }: { tool: ToolCall }) {
    const showLn = useSetting('showLineNumbersInToolViews');
    const input = tool.input ?? {};
    const lang = langForPath(asString(input.file_path));
    return (
        <DiffView
            oldText={trimIdent(asString(input.old_string) ?? '')}
            newText={trimIdent(asString(input.new_string) ?? '')}
            lang={lang}
            showLineNumbers={showLn}
        />
    );
}

function MultiEditView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const showLn = useSetting('showLineNumbersInToolViews');
    const edits = Array.isArray(tool.input?.edits) ? tool.input.edits : [];
    const lang = langForPath(asString(tool.input?.file_path));
    if (edits.length === 0) return <DefaultView tool={tool} />;
    return (
        <div className="tv-stack">
            {edits.map((e: any, i: number) => (
                <div key={i} className="tv-multiedit">
                    <div className="tv-multiedit-head">
                        {t('session.chat.editN' as any, { n: i + 1, total: edits.length })}
                        {e?.replace_all && <span className="tv-badge">{t('session.chat.replaceAll' as any)}</span>}
                    </div>
                    <DiffView
                        oldText={trimIdent(asString(e?.old_string) ?? '')}
                        newText={trimIdent(asString(e?.new_string) ?? '')}
                        lang={lang}
                        showLineNumbers={showLn}
                    />
                </div>
            ))}
        </div>
    );
}

function WriteView({ tool }: { tool: ToolCall }) {
    const showLn = useSetting('showLineNumbersInToolViews');
    const content = asString(tool.input?.content) ?? '';
    const lang = langForPath(asString(tool.input?.file_path));
    return <DiffView oldText="" newText={content} lang={lang} showLineNumbers={showLn} />;
}

// ── Read ─────────────────────────────────────────────────────────────────────
function ReadView({ tool }: { tool: ToolCall }) {
    const filePath = asString(tool.input?.file_path) ?? asString(tool.input?.locations?.[0]?.path);
    const result = tool.result as any;
    const content = asString(result?.file?.content) ?? (typeof result === 'string' ? result : null);
    if (content == null || content.trim() === '') {
        return filePath ? <div className="tv-path">{filePath}</div> : <DefaultView tool={tool} />;
    }
    return <CodeView code={content} lang={langForPath(filePath)} copyable={false} showLineNumbers />;
}

// ── NotebookEdit ──────────────────────────────────────────────────────────────
function NotebookView({ tool }: { tool: ToolCall }) {
    const showLn = useSetting('showLineNumbersInToolViews');
    const source = asString(tool.input?.new_source) ?? asString(tool.input?.source) ?? '';
    if (!source) return <DefaultView tool={tool} />;
    return <DiffView oldText="" newText={source} lang="python" showLineNumbers={showLn} />;
}

// ── TodoWrite ─────────────────────────────────────────────────────────────────
function TodoView({ tool }: { tool: ToolCall }) {
    const result = tool.result as any;
    const todos =
        (Array.isArray(tool.input?.todos) && tool.input.todos) ||
        (Array.isArray(result?.newTodos) && result.newTodos) ||
        [];
    if (todos.length === 0) return <DefaultView tool={tool} />;
    return (
        <ul className="tv-todos">
            {todos.map((todo: any, i: number) => {
                const status = todo?.status;
                const icon =
                    status === 'completed' ? <CheckSquare size={14} /> : status === 'in_progress' ? <Circle size={14} /> : <Square size={14} />;
                return (
                    <li key={todo?.id ?? i} className={`tv-todo tv-todo--${status ?? 'pending'}`}>
                        <span className="tv-todo-icon">{icon}</span>
                        <span className="tv-todo-text">{asString(todo?.content) ?? ''}</span>
                    </li>
                );
            })}
        </ul>
    );
}

// ── Grep / Glob / LS ──────────────────────────────────────────────────────────
function SearchView({ tool }: { tool: ToolCall }) {
    const input = tool.input ?? {};
    const pattern = asString(input.pattern);
    const path = asString(input.path);
    const out = resultToText(tool.result);
    return (
        <div className="tv-stack">
            <div className="tv-query">
                <Search size={13} className="tv-query-icon" />
                <span className="tv-query-text">{pattern ?? path ?? tool.name}</span>
                {pattern && path && <span className="tv-query-in">{path}</span>}
            </div>
            {out.trim() && <pre className="tv-results">{out}</pre>}
        </div>
    );
}

// ── Task / Agent ──────────────────────────────────────────────────────────────
function TaskView({ message }: { message: ToolCallMessage }) {
    const { t } = useTranslation();
    const tool = message.tool;
    const subtype = asString(tool.input?.subagent_type);
    const prompt = asString(tool.input?.prompt);
    const out = resultToText(tool.result);
    const children = (message.children ?? []).filter((c) => c.kind === 'tool-call') as Message[];
    return (
        <div className="tv-stack">
            <div className="tv-task-head">
                {subtype && <span className="tv-badge">{subtype}</span>}
                {children.length > 0 && (
                    <span className="tv-task-count">{t('session.chat.usedTools' as any, { count: children.length })}</span>
                )}
            </div>
            {prompt && <div className="tv-task-prompt">{prompt}</div>}
            {out.trim() && (
                <Section label={t('tools.fullView.output' as any)} defaultOpen={false}>
                    <pre className="tv-results">{out}</pre>
                </Section>
            )}
        </div>
    );
}

// ── WebFetch / WebSearch ────────────────────────────────────────────────────────
function WebView({ tool }: { tool: ToolCall }) {
    const url = asString(tool.input?.url);
    const query = asString(tool.input?.query);
    const out = resultToText(tool.result);
    return (
        <div className="tv-stack">
            <div className="tv-query">
                <Globe size={13} className="tv-query-icon" />
                {url ? (
                    <a className="tv-query-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                ) : (
                    <span className="tv-query-text">{query ?? tool.name}</span>
                )}
            </div>
            {out.trim() && <pre className="tv-results">{out}</pre>}
        </div>
    );
}

// ── Default (incl. all MCP / unrecognized tools) ─────────────────────────────────
function DefaultView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    const out = resultToText(tool.result);
    const inputKeys = Object.keys(tool.input ?? {});
    const hasInput = inputKeys.length > 0;
    // Detect whether the output is structured (JSON) vs prose, for nicer rendering.
    const outIsJson = out.trim().startsWith('{') || out.trim().startsWith('[');
    return (
        <div className="tv-stack">
            {hasInput && (
                <Section label={t('tools.fullView.inputParams' as any)} defaultOpen={!out}>
                    <CodeView code={prettyInput(tool.input)} lang="json" copyable={false} />
                </Section>
            )}
            {error && <div className="tg-error">{error}</div>}
            {out && !error && (
                <Section label={t('tools.fullView.output' as any)} defaultOpen>
                    {outIsJson ? (
                        <CodeView code={out} lang="json" copyable={false} />
                    ) : (
                        <pre className="tv-results">{out}</pre>
                    )}
                </Section>
            )}
            {!hasInput && !out && !error && <div className="tv-empty">{t('tools.fullView.noOutput' as any)}</div>}
        </div>
    );
}

function prettyInput(input: unknown): string {
    try {
        return JSON.stringify(input, null, 2);
    } catch {
        return String(input);
    }
}

export function ToolView({ message }: { message: ToolCallMessage }) {
    const tool = message.tool;
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    let body: ReactNode;
    let handlesOwnError = false;
    switch (tool.name) {
        case 'Bash':
            body = <BashView tool={tool} />;
            handlesOwnError = true;
            break;
        case 'Edit':
            body = <EditView tool={tool} />;
            break;
        case 'MultiEdit':
            body = <MultiEditView tool={tool} />;
            break;
        case 'Write':
            body = <WriteView tool={tool} />;
            break;
        case 'NotebookEdit':
            body = <NotebookView tool={tool} />;
            break;
        case 'Read':
        case 'read':
            body = <ReadView tool={tool} />;
            break;
        case 'TodoWrite':
            body = <TodoView tool={tool} />;
            break;
        case 'Grep':
        case 'Glob':
        case 'LS':
            body = <SearchView tool={tool} />;
            handlesOwnError = true;
            break;
        case 'Task':
        case 'Agent':
            body = <TaskView message={message} />;
            handlesOwnError = true;
            break;
        case 'WebFetch':
        case 'WebSearch':
            body = <WebView tool={tool} />;
            handlesOwnError = true;
            break;
        default:
            // All MCP + unrecognized tools land here with a clean collapsible view.
            body = <DefaultView tool={tool} />;
            handlesOwnError = true;
    }
    return (
        <div className="tv">
            {body}
            {error && !handlesOwnError && <div className="tg-error">{error}</div>}
        </div>
    );
}
