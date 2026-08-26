/**
 * ToolView — specialized per-tool rendering for an expanded tool call.
 * Dispatches on tool name to a purpose-built view; everything unrecognized
 * (including the long tail of MCP tools) gets an attractive default with a
 * collapsible pretty-printed input + output rather than a raw JSON blob.
 */
import { useId, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { CheckSquare, ChevronRight, Circle, Globe, Search, Square } from 'lucide-react';
import type { ToolCallMessage, ToolCall, Message } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { CopyButton } from '@/ui/CopyButton';
import { trimIdent } from '@/utils/trimIdent';
import { knownTools } from '@/components/tools/knownTools';
import { CommandView } from './CommandView';
import { CodeView } from './CodeView';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { AskUserQuestionOptions } from './AskUserQuestionView';
import { detectSelectedLabels } from './askUserQuestion';
import { asCommand, extractError, resultToText } from './toolInfo';
import { langForPath } from './langForPath';
import { FilePathLink } from './FilePathLink';

/** B-145: 工具卡里的文件路径可点 —— sessionId 从路由取（同本文件既有做法）。 */
function ToolPath({ path }: { path: string }) {
    const { id: sessionId } = useParams();
    return sessionId ? <FilePathLink path={path} sessionId={sessionId} /> : <>{path}</>;
}
import './toolview.css';

function asString(v: unknown): string | null {
    return typeof v === 'string' ? v : null;
}

// Collapsible labelled section used by the default / search / web views.
function Section({ label, children, defaultOpen = true }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    const bodyId = useId();
    return (
        <div className="tv-section">
            <button type="button" className="tv-section-head vh-disclosure-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={bodyId}>
                <ChevronRight size={12} className={`tg-chevron${open ? ' is-open' : ''}`} />
                <span>{label}</span>
            </button>
            <div id={bodyId} className="tv-section-body vh-disclosure-panel" hidden={!open}>
                {open && children}
            </div>
        </div>
    );
}

// Tool output text block with a copy overlay. Copies the RAW text passed in —
// the same full string resultToText() produced, never a clipped rendering.
function OutputText({ text }: { text: string }) {
    return (
        <div className="tv-out vh-copyhost">
            <pre className="tv-results">{text}</pre>
            <CopyButton text={text} className="vh-copy--overlay" />
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
                        {t('session.chat.editN', { n: i + 1, total: edits.length })}
                        {e?.replace_all && <span className="tv-badge">{t('session.chat.replaceAll')}</span>}
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
        return filePath ? <div className="tv-path"><ToolPath path={filePath} /></div> : <DefaultView tool={tool} />;
    }
    return <CodeView code={content} lang={langForPath(filePath)} showLineNumbers />;
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
            {out.trim() && <OutputText text={out} />}
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
                    <span className="tv-task-count">{t('session.chat.usedTools', { count: children.length })}</span>
                )}
            </div>
            {prompt && <div className="tv-task-prompt">{prompt}</div>}
            {out.trim() && (
                <Section label={t('tools.fullView.output')} defaultOpen={false}>
                    <OutputText text={out} />
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
            {out.trim() && <OutputText text={out} />}
        </div>
    );
}

// ── ExitPlanMode (incl. lowercase alias) ─────────────────────────────────────
// Renders input.plan as Markdown with a plan badge (B-100) instead of the
// JSON.stringify default. Parses via the knownTools zod schema; anything that
// doesn't validate falls back to DefaultView untouched.
function PlanView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const parsed = knownTools['ExitPlanMode'].input.safeParse(tool.input ?? {});
    const plan = parsed.success && typeof parsed.data.plan === 'string' && parsed.data.plan.trim() !== ''
        ? parsed.data.plan
        : null;
    if (!plan) return <DefaultView tool={tool} />;
    return (
        <div className="tv-plan">
            <div className="tv-plan-head">{t('tools.names.planProposal')}</div>
            <div className="tv-plan-body">
                <Markdown text={plan} />
            </div>
        </div>
    );
}

// ── AskUserQuestion ───────────────────────────────────────────────────────────
// header chip + question + clickable options (B-100). A click sends the option
// label as a PLAIN user message via sync.sendMessage — that is what the model
// consumes. Once the tool has a result the options render inert, with the
// chosen label highlighted when the result reveals it.
function QuestionView({ tool }: { tool: ToolCall }) {
    // ChatList doesn't thread sessionId through ToolGroupView (frozen file for
    // this batch) — the session route param IS the sessionId.
    const { id: sessionId } = useParams();
    const [sent, setSent] = useState(false);
    const parsed = knownTools['AskUserQuestion'].input.safeParse(tool.input ?? {});
    const questions =
        parsed.success && Array.isArray(parsed.data.questions) && parsed.data.questions.length > 0
            ? parsed.data.questions
            : null;
    if (!questions || !sessionId) return <DefaultView tool={tool} />;
    const answered = tool.result != null || tool.state === 'completed' || tool.state === 'error';
    const selected = answered
        ? detectSelectedLabels(
              resultToText(tool.result),
              questions.flatMap((q) => (q.options ?? []).map((o) => o.label)),
          )
        : [];
    return (
        <AskUserQuestionOptions
            questions={questions}
            disabled={answered || sent}
            selected={selected}
            onSubmit={(text) => {
                setSent(true);
                void sync.sendMessage(sessionId, text, { source: 'question' });
            }}
        />
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
                <Section label={t('tools.fullView.inputParams')} defaultOpen={!out}>
                    <CodeView code={prettyInput(tool.input)} lang="json" />
                </Section>
            )}
            {error && <div className="tg-error">{error}</div>}
            {out && !error && (
                <Section label={t('tools.fullView.output')} defaultOpen>
                    {outIsJson ? (
                        <CodeView code={out} lang="json" />
                    ) : (
                        <OutputText text={out} />
                    )}
                </Section>
            )}
            {!hasInput && !out && !error && <div className="tv-empty">{t('tools.fullView.noOutput')}</div>}
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
        case 'ExitPlanMode':
        case 'exit_plan_mode':
            body = <PlanView tool={tool} />;
            break;
        case 'AskUserQuestion':
            body = <QuestionView tool={tool} />;
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
