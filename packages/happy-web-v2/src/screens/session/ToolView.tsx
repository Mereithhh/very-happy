/**
 * ToolView — specialized per-tool rendering for an expanded tool call.
 * Dispatches on tool name to a purpose-built view (Bash terminal, Edit/Write
 * diff, Read content, TodoWrite checklist, Grep/Glob/LS results, Task subagent,
 * WebFetch/WebSearch), with a JSON-ish default for unknown tools.
 */
import type { ReactNode } from 'react';
import { CheckSquare, Circle, Square, Globe, Search } from 'lucide-react';
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
    const oldString = trimIdent(asString(input.old_string) ?? '');
    const newString = trimIdent(asString(input.new_string) ?? '');
    return <DiffView oldText={oldString} newText={newString} showLineNumbers={showLn} />;
}

function MultiEditView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const showLn = useSetting('showLineNumbersInToolViews');
    const edits = Array.isArray(tool.input?.edits) ? tool.input.edits : [];
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
    return <DiffView oldText="" newText={content} showLineNumbers={showLn} />;
}

// ── Read ─────────────────────────────────────────────────────────────────────
function ReadView({ tool }: { tool: ToolCall }) {
    const filePath = asString(tool.input?.file_path) ?? asString(tool.input?.locations?.[0]?.path);
    const result = tool.result as any;
    const content = asString(result?.file?.content) ?? (typeof result === 'string' ? result : null);
    if (content == null) {
        return filePath ? <div className="tv-path">{filePath}</div> : <DefaultView tool={tool} />;
    }
    return <CodeView code={content} lang={langForPath(filePath)} copyable={false} />;
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

// ── Default ───────────────────────────────────────────────────────────────────
function DefaultView({ tool }: { tool: ToolCall }) {
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    const out = resultToText(tool.result);
    const hasInput = Object.keys(tool.input ?? {}).length > 0;
    return (
        <div className="tv-stack">
            {hasInput && <CodeView code={JSON.stringify(tool.input, null, 2)} lang="json" copyable={false} />}
            {error && <div className="tg-error">{error}</div>}
            {out && !error && <CodeView code={out} lang={null} copyable={false} />}
        </div>
    );
}

export function ToolView({ message }: { message: ToolCallMessage }) {
    const tool = message.tool;
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    let body: ReactNode;
    switch (tool.name) {
        case 'Bash':
            body = <BashView tool={tool} />;
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
            break;
        case 'Task':
        case 'Agent':
            body = <TaskView message={message} />;
            break;
        case 'WebFetch':
        case 'WebSearch':
            body = <WebView tool={tool} />;
            break;
        default:
            body = <DefaultView tool={tool} />;
    }
    return (
        <div className="tv">
            {body}
            {/* Edit/Read-style views don't surface tool errors themselves — show here. */}
            {error && tool.name !== 'Bash' && tool.name !== 'Grep' && tool.name !== 'Glob' && tool.name !== 'LS' && tool.name !== 'WebFetch' && tool.name !== 'WebSearch' && (
                <div className="tg-error">{error}</div>
            )}
        </div>
    );
}
