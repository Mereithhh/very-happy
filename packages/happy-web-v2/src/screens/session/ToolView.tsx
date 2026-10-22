import { openSubagentPanel } from './subagentPanelState';
import { useSubagentNavigation } from './subagentNavigation';
import { previewToolPath } from './previewTools';
/**
 * ToolView — specialized per-tool rendering for an expanded tool call.
 * Dispatches on tool name to a purpose-built view; everything unrecognized
 * (including the long tail of MCP tools) gets an attractive default with a
 * collapsible pretty-printed input + output rather than a raw JSON blob.
 */
import { useId, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { BookOpen, CheckSquare, ChevronRight, Circle, FileText, Globe, Search, Square } from 'lucide-react';
import type { ToolCallMessage, ToolCall } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { useSetting } from '@/sync/storage';
import { sessionAllow } from '@/sync/ops';
import { CopyButton } from '@/ui/CopyButton';
import { trimIdent } from '@/utils/trimIdent';
import { knownTools } from '@/components/tools/knownTools';
import { CommandView } from './CommandView';
import { CodeView } from './CodeView';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { AskUserQuestionOptions } from './AskUserQuestionView';
import { useTranscriptQuestionPlacement } from './usePinnedRequest';
import { detectSelectedLabels } from './askUserQuestion';
import { asCommand, emptyStateKey, extractError, resultToText } from './toolInfo';
import { SubagentDetail } from './SubagentDetail';
import { langForPath } from './langForPath';
import { FilePathLink } from './FilePathLink';
import { resolveBuiltinTool } from '@/components/tools/builtinTools';
import { BuiltinToolView } from './BuiltinToolView';
import { keyValueRows, parseJsonText } from '@/components/tools/toolKeyValues';
import {
    acpInfo, acpResultText, commandInfo, fetchUrl, mcpIdentity, parseFetchedPage, parseSearchLinks, patchEdits,
    readInfo, searchQuery, shortUrl, stripReadLineNumbers, toolCardKind,
} from '@/components/tools/toolPresentation';
import { KvTable, LinkList, RawData } from './ToolCardParts';

/** B-145: 工具卡里的文件路径可点 —— sessionId 从路由取（同本文件既有做法）。 */
function ToolPath({ path }: { path: string }) {
    const { id: sessionId } = useParams();
    return sessionId ? <FilePathLink path={path} sessionId={sessionId} /> : <>{path}</>;
}
import './toolview.css';
import { RecoverableBoundary } from '@/ui/RecoverableBoundary';

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

// ── Bash / CodexBash / ACP execute ───────────────────────────────────────────
function BashView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const cmd = asCommand(tool);
    if (!cmd) return <DefaultView tool={tool} />;
    const info = commandInfo(tool);
    return (
        <div className="tv-stack">
            {info?.cwd && <div className="tv-note"><span className="tv-note-label">{t('tools.card.cwd')}</span><span className="tv-path"><ToolPath path={info.cwd} /></span></div>}
            <CommandView command={cmd.command} stdout={cmd.stdout} stderr={cmd.stderr} error={cmd.error} />
        </div>
    );
}

// ── CodexPatch / CodexDiff / GeminiDiff / ACP edit (per-file diffs) ───────────
function PatchView({ tool }: { tool: ToolCall }) {
    const showLn = useSetting('showLineNumbersInToolViews');
    const edits = patchEdits(tool).filter((e) => e.path || e.renders.length);
    if (edits.length === 0) return <DefaultView tool={tool} />;
    return (
        <div className="tv-stack">
            {edits.map((edit, i) => (
                <div key={`${edit.path}-${i}`} className="tv-stack">
                    <div className="tv-file-head">
                        <span className="tv-file-path">{edit.path ? <ToolPath path={edit.path} /> : null}</span>
                        {/* DiffView's own bar carries +/− when there is a body to show. */}
                        {edit.renders.length === 0 && edit.added !== null && <span className="tv-file-stat tv-file-stat-add">+{edit.added}</span>}
                        {edit.renders.length === 0 && edit.removed !== null && <span className="tv-file-stat tv-file-stat-del">−{edit.removed}</span>}
                    </div>
                    {edit.renders.map((r, j) => (
                        <DiffView key={j} oldText={r.oldText} newText={r.newText} lang={langForPath(edit.path)} showLineNumbers={showLn} />
                    ))}
                </div>
            ))}
        </div>
    );
}

// ── Monitor (Claude background watch) ─────────────────────────────────────────
function MonitorView({ tool }: { tool: ToolCall }) {
    const command = asString(tool.input?.command);
    const out = resultToText(tool.result);
    const rest = keyValueRows({ timeout_ms: tool.input?.timeout_ms, persistent: tool.input?.persistent });
    return (
        <div className="tv-stack">
            {command && <CommandView command={command} />}
            <KvTable rows={rest} />
            {out.trim() && <div className="tv-prose">{out.trim()}</div>}
        </div>
    );
}

// ── think / CodexReasoning / GeminiReasoning ──────────────────────────────────
function ThinkView({ tool }: { tool: ToolCall }) {
    const items = Array.isArray(tool.input?.items) ? acpResultText(tool.input.items) : null;
    const text = items ?? acpResultText(tool.result);
    // A title-only reasoning step is already the row's detail — nothing more to show.
    if (!text?.trim()) return null;
    return <div className="tv-prose">{text.trim()}</div>;
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
    const { path: filePath, range } = readInfo(tool);
    const result = tool.result as any;
    const raw = asString(result?.file?.content) ?? (typeof result === 'string' ? result : acpResultText(result));
    if (raw == null || raw.trim() === '') {
        return filePath ? <div className="tv-path"><ToolPath path={filePath} />{range ? `:${range}` : ''}</div> : <DefaultView tool={tool} />;
    }
    // B-754: Claude's Read text is `cat -n` output — the gutter numbers it instead.
    const { code, startLine } = stripReadLineNumbers(raw);
    const offset = typeof tool.input?.offset === 'number' ? tool.input.offset : null;
    return <CodeView code={code} lang={langForPath(filePath)} showLineNumbers startLine={startLine > 1 ? startLine : offset ?? 1} />;
}

function SkillView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const input = tool.input ?? {};
    const name = asString(input.skill) ?? asString(input.name) ?? asString(input.path) ?? tool.name;
    const out = resultToText(tool.result);
    return (
        <div className="tv-stack">
            <div className="tv-skill">
                <BookOpen size={13} />
                <span>{t('tools.names.skillLoaded')}</span>
                <strong>{name}</strong>
            </div>
            {out.trim() && (
                <Section label={t('tools.fullView.output')} defaultOpen={false}>
                    <OutputText text={out} />
                </Section>
            )}
        </div>
    );
}

function AttachmentFileView({ tool }: { tool: ToolCall }) {
    const name = asString(tool.input?.name) ?? 'attachment';
    const mimeType = asString(tool.input?.mimeType);
    const size = typeof tool.input?.size === 'number' ? tool.input.size : null;
    const sizeLabel = size === null
        ? null
        : size >= 1024 * 1024
            ? `${(size / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.max(1, Math.round(size / 1024))} KB`;
    return (
        <div className="tv-attachment">
            <FileText size={18} />
            <div className="tv-attachment-copy">
                <strong>{name}</strong>
                {(mimeType || sizeLabel) && <span>{[mimeType, sizeLabel].filter(Boolean).join(' · ')}</span>}
            </div>
        </div>
    );
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
    const acp = acpInfo(tool);
    const pattern = asString(input.pattern) ?? (acp ? searchQuery(tool) : null);
    const path = asString(input.path) ?? asString(acp?.raw.path);
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

// ── Task / Agent — sub-agent detail (B-260, redesigned in B-317) ─────────────
// The body now lives in SubagentDetail so the drawer and this inline fallback
// can never drift apart. Inline only happens where there is no session route to
// open a drawer from (the dev harness); inside a session, ToolGroupView turns
// the row into a pointer and never mounts this.

// ── WebFetch / WebSearch ────────────────────────────────────────────────────────
function WebSearchView({ tool }: { tool: ToolCall }) {
    const query = searchQuery(tool);
    const out = resultToText(tool.result);
    const parsed = out.trim() ? parseSearchLinks(out) : null;
    return (
        <div className="tv-stack">
            <div className="tv-query">
                <Search size={13} className="tv-query-icon" aria-hidden />
                <span className="tv-query-text">{query ?? tool.name}</span>
            </div>
            {parsed ? <LinkList links={parsed.links} /> : out.trim() && <ResultBlock text={out} />}
            {parsed?.rest && <Markdown text={parsed.rest} />}
        </div>
    );
}

function FetchView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const url = fetchUrl(tool);
    const args = mcpIdentity(tool)?.args ?? tool.input ?? {};
    const ask = asString(args.prompt) ?? asString(args.question);
    const out = resultToText(tool.result);
    const page = out.trim() ? parseFetchedPage(out) : null;
    return (
        <div className="tv-stack">
            <div className="tv-query">
                <Globe size={13} className="tv-query-icon" aria-hidden />
                {url ? (
                    <a className="tv-query-link" href={url} target="_blank" rel="noopener noreferrer" title={url}>{page?.title ?? shortUrl(url)}</a>
                ) : (
                    <span className="tv-query-text">{asString(acpInfo(tool)?.title) ?? tool.name}</span>
                )}
            </div>
            {ask && <div className="tv-note"><span className="tv-note-label">{t('tools.card.prompt')}</span>{ask}</div>}
            {page?.body.trim() && <OutputText text={page.body.trim()} />}
        </div>
    );
}

/**
 * A result: search hits become links, a JSON object a key/value table, a
 * short sentence stays prose, and anything longer the copyable output well.
 */
function ResultBlock({ text }: { text: string }) {
    const { t } = useTranslation();
    const links = parseSearchLinks(text);
    if (links) return <LinkList links={links.links} />;
    const json = parseJsonText(text);
    if (json !== undefined) {
        const rows = keyValueRows(json);
        if (rows.length) return <div className="tv-result"><KvTable rows={rows} label={t('tools.card.result')} /></div>;
    }
    const trimmed = text.trim();
    if (trimmed.length <= 280 && trimmed.split('\n').length <= 3) return <div className="tv-result tv-prose">{trimmed}</div>;
    return <OutputText text={text} />;
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
// header chip + question + clickable options (B-100/B-229). A click answers the
// pending AskUserQuestion tool by injecting its `answers` map into updatedInput.
// Once the tool has a result the options render inert, with the chosen label
// highlighted when the result reveals it.
function QuestionView({ tool }: { tool: ToolCall }) {
    // ChatList doesn't thread sessionId through ToolGroupView (frozen file for
    // this batch) — the session route param IS the sessionId.
    const { t } = useTranslation();
    const { id: sessionId } = useParams();
    const [sent, setSent] = useState(false);
    const livePendingId = tool.permission?.status === 'pending' ? tool.permission.id : null;
    // B-563: while the request is answerable in the dock above the composer,
    // this copy is a read-only receipt — one actionable card, not two. A
    // terminal mirror (B-105) is read-only here too.
    const placement = useTranscriptQuestionPlacement(sessionId, livePendingId);
    const parsed = knownTools['AskUserQuestion'].input.safeParse(tool.input ?? {});
    const questions =
        parsed.success && Array.isArray(parsed.data.questions) && parsed.data.questions.length > 0
            ? parsed.data.questions
            : null;
    if (!questions || !sessionId) return <DefaultView tool={tool} />;
    const answered = tool.result != null || tool.state === 'completed' || tool.state === 'error';
    const pendingRequestId = livePendingId;
    const selected = answered
        ? detectSelectedLabels(
              resultToText(tool.result),
              questions.flatMap((q) => (q.options ?? []).map((o) => o.label)),
          )
        : [];
    if (placement !== 'inline' && !answered) {
        return (
            <div className="tv-stack">
                <AskUserQuestionOptions questions={questions} disabled stacked selected={[]} onSubmit={() => {}} />
                {placement === 'dock' && <div className="tv-ask-pinned">{t('session.permission.answerAbove')}</div>}
            </div>
        );
    }
    return (
        <AskUserQuestionOptions
            questions={questions}
            disabled={answered || sent || !pendingRequestId}
            stacked={answered || sent || !pendingRequestId}
            selected={selected}
            onSubmit={(answers) => {
                if (!pendingRequestId) return;
                setSent(true);
                void sessionAllow(
                    sessionId,
                    pendingRequestId,
                    undefined,
                    undefined,
                    'approved',
                    { answers },
                ).catch(() => setSent(false));
            }}
        />
    );
}

// ── Default (incl. all MCP / unrecognized tools) ─────────────────────────────────
// B-754: arguments and JSON results render as a key/value table; the raw
// payload is only in the collapsed 「原始数据」 that every card ends with.
function DefaultView({ tool }: { tool: ToolCall }) {
    const { t } = useTranslation();
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    const out = resultToText(tool.result);
    const acp = acpInfo(tool);
    const args = mcpIdentity(tool)?.args ?? (acp ? acp.raw : tool.input);
    const rows = keyValueRows(args);
    // Codex collaboration results echo the call's own arguments — not worth a second table.
    const echoed = echoesInput(parseJsonText(out), args);
    return (
        <div className="tv-stack">
            {rows.length > 0 && <KvTable rows={rows} label={t('tools.card.arguments')} />}
            {error && <div className="tg-error">{error}</div>}
            {out.trim() && !error && !echoed && <ResultBlock text={out} />}
            {rows.length === 0 && !out.trim() && !error && <div className="tv-empty">{t(emptyStateKey(tool))}</div>}
        </div>
    );
}

function echoesInput(result: unknown, input: unknown): boolean {
    if (!result || typeof result !== 'object' || Array.isArray(result) || !input || typeof input !== 'object') return false;
    const entries = Object.entries(result as Record<string, unknown>);
    return entries.length > 0 && entries.every(([k, v]) => JSON.stringify((input as Record<string, unknown>)[k]) === JSON.stringify(v));
}

/** Sub-agent cards mark their own truncated report (SubagentDetail). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Cards whose body already IS the whole payload (or a live control). */
const NO_RAW = new Set(['AskUserQuestion', 'Task', 'Agent', 'file', 'TodoWrite', 'ExitPlanMode', 'exit_plan_mode']);

/** B-565: a tool card's body crashing must not take the transcript with it. */
export function ToolView(props: { message: ToolCallMessage; abortedAt?: number | null }) {
    return (
        <RecoverableBoundary region="tool" resetKey={props.message} compact>
            <ToolViewBody {...props} />
        </RecoverableBoundary>
    );
}

function ToolViewBody({ message, abortedAt = null }: { message: ToolCallMessage; abortedAt?: number | null }) {
    const { t } = useTranslation();
    const {id:sessionId}=useParams();
    const subagentNavigation = useSubagentNavigation();
    const tool = message.tool;
    if (tool.name === 'CodexCollaboration' && sessionId && subagentNavigation === 'session' && Array.isArray(tool.input?.receiverThreadIds) && tool.input.receiverThreadIds.length) {
        return <button type="button" className="sa-dock-item" onClick={()=>openSubagentPanel(sessionId,message.id)}>Codex · {tool.input.operation} →</button>;
    }
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    let body: ReactNode;
    let handlesOwnError = false;
    const previewPath = previewToolPath(tool);
    if (previewPath) return <div className="tv"><ToolPath path={previewPath} />{error && <div className="tg-error">{error}</div>}</div>;
    // B-499: every very-happy built-in tool (teams, automations, sessions, clipboard,
    // progress…) in any runner's name shape gets its structured card; unknown MCP
    // tools keep the generic collapsible JSON below.
    const builtin = resolveBuiltinTool(tool);
    if (builtin) return <div className="tv"><BuiltinToolView resolved={builtin} tool={tool} /></div>;
    switch (tool.name) {
        case 'Bash':
        case 'CodexBash':
        case 'GeminiBash':
        case 'shell':
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
        case 'Skill':
        case 'read_skill':
            body = <SkillView tool={tool} />;
            break;
        case 'file':
            body = <AttachmentFileView tool={tool} />;
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
            body = <SubagentDetail message={message} abortedAt={abortedAt} />;
            handlesOwnError = true;
            break;
        case 'WebFetch':
            body = <FetchView tool={tool} />;
            break;
        case 'WebSearch':
            body = <WebSearchView tool={tool} />;
            break;
        case 'Monitor':
            body = <MonitorView tool={tool} />;
            break;
        case 'ExitPlanMode':
        case 'exit_plan_mode':
            body = <PlanView tool={tool} />;
            break;
        case 'AskUserQuestion':
            body = <QuestionView tool={tool} />;
            break;
        default: {
            // B-754: other runners' shapes of the same operations get the same
            // cards; everything else (unknown MCP tools…) the key/value table.
            const kind = tool.name.toLowerCase().endsWith('__read_skill') ? 'skill' : toolCardKind(tool);
            body = kind === 'skill' ? <SkillView tool={tool} />
                : kind === 'command' ? <BashView tool={tool} />
                : kind === 'patch' ? <PatchView tool={tool} />
                : kind === 'read' ? <ReadView tool={tool} />
                : kind === 'search' ? <SearchView tool={tool} />
                : kind === 'webSearch' ? <WebSearchView tool={tool} />
                : kind === 'fetch' ? <FetchView tool={tool} />
                : kind === 'monitor' ? <MonitorView tool={tool} />
                : kind === 'think' ? <ThinkView tool={tool} />
                : <DefaultView tool={tool} />;
            handlesOwnError = kind === 'command' || kind === 'search' || kind === 'generic' || kind === 'skill';
        }
    }
    return (
        <div className="tv">
            {body}
            {error && !handlesOwnError && <div className="tg-error">{error}</div>}
            {tool.resultTruncated && !SUBAGENT_TOOLS.has(tool.name) && <div className="tv-truncated">{t('tools.card.resultTruncated')}</div>}
            {!NO_RAW.has(tool.name) && <RawData input={tool.input} result={tool.result} />}
        </div>
    );
}
