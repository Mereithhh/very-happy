/**
 * Markdown 渲染（GFM）。
 *
 * 引擎是 `react-markdown` + `remark-gfm` + `remark-breaks`，渲染成**真 React 节点**，
 * 全程没有 `dangerouslySetInnerHTML`——agent 输出是不可信文本，「标记进不了 DOM」必须是
 * 结构性保证，而不是「sanitizer 配对了」这种可配置的保证。原始 HTML（含 `<script>`）
 * 被引擎转义成可见文本，与替换前的手写渲染器行为一致。
 *
 * 换掉手写渲染器的原因（2026-09-04，15 例探针）：它的段落收集循环 break 列表里没有
 * table，于是「结论如下：」后面紧跟表格（LLM 最常见写法，中间不空行）时整张表被吞进
 * 一个 `<p>`；另外转义竖线切错列、数据行少一格就列错位、嵌套列表被拍平、`foo_bar_baz`
 * 被当斜体、task list / 删除线 / 自动链接 / 引用式链接 / 脚注全不支持。设计取舍、
 * 被否决的候选（streamdown / markdown-to-jsx / marked+sanitizer）与实测数据见
 * `specs/2026-09-markdown-engine-and-attachments.md`。
 *
 * 三条**不可回退**的接线（每条都有回归测试，见 markdownRender.test.tsx）：
 *  1. 路径链接（B-145）走 `rehypeTextLeaves` + `vh-text` 叶子组件，**白名单从 context 读、
 *     不进插件参数**，否则白名单一变就是整条 transcript 重 parse（见 markdownPlugins.ts）。
 *  2. `<options>` 块**不进引擎**（引擎会把它转义成可见 XML），在 `splitOptionSegments`
 *     里先切走（见 optionsBlock.ts）。
 *  3. 代码块交给 `CodeView`（shiki + 折叠 + 复制），通过 `components.pre` 从 hast 节点取原文。
 */
import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ChevronDown, FileText } from 'lucide-react';
import { CodeView } from './CodeView';
import { MermaidView } from './MermaidView';
import { shouldCollapseTable } from './codeCollapse';
import { useTranslation } from '@/i18n/useTranslation';
import './markdown.css';
import { FilePathLink } from './FilePathLink';
import { collectSessionFilePaths, findPathHits } from './toolFilePath';
import { useSessionMessages } from '@/sync/storage';
import { splitOptionSegments } from './optionsBlock';
import { rehypeTableCellBreaks, rehypeTableScope, rehypeTextLeaves, safeUrlTransform } from './markdownPlugins';
import { streamThrottleMs } from './streamThrottle';

// Stable identities: react-markdown re-runs the whole unified pipeline on every
// render, and a fresh array here would also invalidate the memo below.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeTableCellBreaks, rehypeTableScope, rehypeTextLeaves];

/* ── path links (B-145) ─────────────────────────────────────────────────── */

interface PathLinkCtx { sessionId: string; allowlist: ReadonlySet<string> }
const PathLinkContext = React.createContext<PathLinkCtx | null>(null);

/**
 * 显式给定白名单的 scope。`MarkdownPathProvider` 是它的会话版包装（从消息里推白名单），
 * 测试与非会话调用方用这个。
 */
export function PathLinksScope({ sessionId, allowlist, children }: {
    sessionId: string;
    allowlist: ReadonlySet<string>;
    children: React.ReactNode;
}) {
    const value = React.useMemo(() => ({ sessionId, allowlist }), [sessionId, allowlist]);
    return <PathLinkContext.Provider value={value}>{children}</PathLinkContext.Provider>;
}

/** 在这棵子树里关掉路径链接（流式草稿用：1.5 秒后落地的持久化消息照样会把路径链上）。 */
export function NoPathLinks({ children }: { children: React.ReactNode }) {
    return <PathLinkContext.Provider value={null}>{children}</PathLinkContext.Provider>;
}

/**
 * 唯一读 path context 的地方。
 *
 * `Markdown` 自己**绝不能**读它：那样白名单一变就会重渲整个 `<ReactMarkdown>`，
 * 而它没有 parse 缓存。叶子读 context 时，React 会穿透上层 memo 只更新这些叶子
 * （实测 `parse +0 / leaf +N`）。
 */
function TextLeaf({ text }: { text: string }) {
    const ctx = React.useContext(PathLinkContext);
    const hits = React.useMemo(
        () => (ctx ? findPathHits(text, ctx.allowlist) : []),
        [text, ctx],
    );
    if (!ctx || hits.length === 0) return <>{text}</>;
    const out: React.ReactNode[] = [];
    let cursor = 0;
    hits.forEach((hit, i) => {
        if (hit.start > cursor) out.push(text.slice(cursor, hit.start));
        out.push(
            <FilePathLink key={`p${i}`} path={hit.path} sessionId={ctx.sessionId} className="md-path" />,
        );
        cursor = hit.end;
    });
    if (cursor < text.length) out.push(text.slice(cursor));
    return <>{out}</>;
}

/* ── table ──────────────────────────────────────────────────────────────── */

/**
 * 可滚动区必须能用键盘滚（WCAG 2.1.1），但**只有真的溢出时**才给 tab stop——
 * 长会话里十几张表就是十几次 Tab。同一个信号顺便开关滚动阴影。
 */
function useOverflowX<T extends HTMLElement>() {
    const ref = React.useRef<T>(null);
    const [overflowing, setOverflowing] = React.useState(false);
    React.useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const measure = () => setOverflowing(node.scrollWidth - node.clientWidth > 1);
        // Measure BEFORE the observer guard: without a ResizeObserver the class
        // would never be set at all, and under `overflow-x: clip` that means a wide
        // table is silently cut with no way to scroll it.
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        for (const child of Array.from(node.children)) observer.observe(child);
        return () => observer.disconnect();
    }, []);
    return { ref, overflowing };
}

function countBodyRows(node: unknown): number {
    const walk = (n: unknown): number => {
        const el = n as { tagName?: string; children?: unknown[] } | undefined;
        if (!el?.children) return 0;
        if (el.tagName === 'tbody') {
            return el.children.filter((c) => (c as { tagName?: string }).tagName === 'tr').length;
        }
        return el.children.reduce((sum: number, c) => sum + walk(c), 0);
    };
    return walk(node);
}

/**
 * 表格：横向按需滚动 + 超长时折叠 + 展开后表头吸顶（B-356）。
 *
 * 三条 CSS 事实决定了这个结构（真实 Chromium 实测，见
 * `specs/2026-09-table-collapse-and-mermaid.md` §B）：
 *  1. `overflow-x: auto` 会把 `overflow-y` 的计算值也变成 `auto`，包裹器于是成了 Y 滚动容器，
 *     `position: sticky` 会贴到它自己的顶边（而它从不竖滚）⇒ 吸顶完全失效。所以横滚**只在
 *     真的溢出时**才开，其余 97.7% 的表用 `overflow-x: clip`（`clip` 不会把另一轴强制成 auto）。
 *  2. `overflow` 为 `clip`/`visible` 的盒子**不裁 Y**，所以 `max-height` 必须挂在**外层**
 *     另一个 `overflow: hidden` 的盒子上。
 *  3. 那个外层盒子只能在**折叠态**存在：`overflow:hidden` 的祖先会把 sticky 钉死在自己里面。
 */
function MarkdownTable({ children, node }: { children?: React.ReactNode; node?: unknown }) {
    const { t } = useTranslation();
    const { ref, overflowing } = useOverflowX<HTMLDivElement>();
    const [expanded, setExpanded] = React.useState(false);
    const bodyId = React.useId();
    const rowCount = React.useMemo(() => countBodyRows(node), [node]);
    const canCollapse = shouldCollapseTable(rowCount);
    const collapsed = canCollapse && !expanded;

    return (
        <div className="md-tbl">
            <div id={bodyId} className={collapsed ? 'md-tbl-body md-tbl-body--collapsed' : 'md-tbl-body'}>
                <div
                    ref={ref}
                    className={`md-table-wrap${overflowing ? ' is-scrollable' : ''}`}
                    {...(overflowing ? { tabIndex: 0, role: 'region', 'aria-label': t('session.chat.tableRegion') } : {})}
                >
                    <table className="md-table">{children}</table>
                </div>
                {collapsed && <div className="md-tbl-fade" aria-hidden />}
            </div>
            {canCollapse && (
                <button
                    type="button"
                    className="md-tbl-expand vh-disclosure-trigger"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={!collapsed}
                    aria-controls={bodyId}
                >
                    <span>{collapsed
                        ? t('session.chat.expandTableRows', { rows: rowCount })
                        : t('session.chat.collapseTableRows')}</span>
                    <ChevronDown size={13} className={`vh-disclosure-icon${!collapsed ? ' is-open' : ''}`} aria-hidden />
                </button>
            )}
        </div>
    );
}

/* ── components map ─────────────────────────────────────────────────────── */

function hastText(node: unknown): string {
    const element = node as { children?: unknown[] } | undefined;
    let out = '';
    const walk = (nodes: unknown[] | undefined) => {
        for (const child of nodes ?? []) {
            const c = child as { type?: string; value?: string; children?: unknown[] };
            if (c.type === 'text' || c.type === 'raw') out += c.value ?? '';
            else if (c.children) walk(c.children);
        }
    };
    walk(element?.children);
    return out;
}

function buildComponents(plainCode: boolean, trustContent: boolean): Components {
    return {
        // `pre`, not `code`: mapping `code` cannot tell an inline span from a
        // fenced block without inspecting the parent, and CodeView needs the raw
        // source anyway (rehypeTextLeaves skips <pre> so the hast is intact).
        pre({ node }) {
            const first = (node as { children?: Array<{ properties?: { className?: unknown } }> } | undefined)?.children?.[0];
            const classes = Array.isArray(first?.properties?.className) ? first.properties.className as string[] : [];
            const lang = classes.map((c) => /^language-(.+)$/.exec(c)?.[1]).find(Boolean) ?? null;
            const code = hastText(first).replace(/\n$/, '');
            // B-357: a mermaid fence becomes a diagram — but never while streaming.
            // A half-written diagram cannot parse, and the draft re-renders several
            // times a second, so it would be a stream of failed renders.
            if (lang === 'mermaid' && !plainCode) return <MermaidView code={code} />;
            return <CodeView code={code} lang={lang} plain={plainCode} />;
        },
        code({ children, className }) {
            // Only inline spans reach here now — fenced blocks are consumed by `pre`.
            return <code className={`md-code-inline${className ? ` ${className}` : ''}`}>{children}</code>;
        },
        a({ href, children }) {
            return (
                <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
                    {children}
                </a>
            );
        },
        img({ src, alt, title }) {
            // agent 正文是不可信内容：一个远程图片就是一个追踪像素 + IP/UA 泄漏，而且
            // react-markdown 除了 <img> 还会注入 <link rel="preload" as="image">。
            // 只有明确标记 trustContent 的调用方（用户自己的 .md 文件预览）才真出图。
            if (trustContent) {
                return <img className="md-img" src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} title={title} />;
            }
            const label = alt?.trim() || (typeof src === 'string' ? src : '') || 'image';
            return (
                <span className="md-img-chip" title={typeof src === 'string' ? src : undefined}>
                    <FileText size={12} aria-hidden />
                    {label}
                </span>
            );
        },
        table({ children, node }) {
            return <MarkdownTable node={node}>{children}</MarkdownTable>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'vh-text': ({ node }: any) => <TextLeaf text={hastText(node)} />,
    } as Components;
}

/* ── streaming throttle ─────────────────────────────────────────────────── */

/** 草稿重渲节流（取舍与实测数据见 streamThrottle.ts）。短文本不节流。 */
function useThrottledText(text: string, enabled: boolean): string {
    const [shown, setShown] = React.useState(text);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = React.useRef(text);
    latest.current = text;

    React.useEffect(() => {
        const interval = enabled ? streamThrottleMs(text.length) : 0;
        if (interval === 0) {
            if (timer.current) {
                clearTimeout(timer.current);
                timer.current = null;
            }
            setShown(text);
            return;
        }
        if (timer.current) return;                  // a tick is already pending
        timer.current = setTimeout(() => {
            timer.current = null;
            setShown(latest.current);
        }, interval);
    }, [text, enabled]);

    React.useEffect(() => () => {
        // `timer.current = null` is NOT optional. StrictMode runs a simulated
        // unmount/remount while KEEPING the fiber's refs, so clearing the
        // timeout without clearing the ref leaves a dead id behind — every
        // later effect then hits `if (timer.current) return` and no further
        // tick is ever scheduled. Measured in dev: a draft froze at the length
        // it had when it first crossed the throttle threshold.
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    }, []);

    return enabled ? shown : text;
}

/* ── public component ───────────────────────────────────────────────────── */

export function Markdown({ text, onOption, plainCode = false, streaming = false, trustContent = false }: {
    text: string;
    onOption?: (option: string) => void;
    /** B-309: render fenced code without highlighting (streaming drafts). */
    plainCode?: boolean;
    /** Live draft: throttle re-parse (react-markdown has no parse cache). */
    streaming?: boolean;
    /**
     * The text is the USER's own content (a local .md file preview), not agent
     * output — remote images are legitimate there. Default false: everything in
     * the transcript is untrusted.
     */
    trustContent?: boolean;
}) {
    const shownText = useThrottledText(text, streaming);
    const segments = React.useMemo(() => splitOptionSegments(shownText), [shownText]);
    const components = React.useMemo(() => buildComponents(plainCode, trustContent), [plainCode, trustContent]);

    // The element identity is what keeps a path-allowlist change (a context
    // update consumed only by TextLeaf) from re-parsing the whole transcript.
    return React.useMemo(() => (
        <div className="md">
            {segments.map((segment, index) => {
                if (segment.kind === 'options') {
                    return (
                        <div key={index} className="md-options">
                            {segment.items.map((item, j) => (onOption ? (
                                <button key={j} type="button" className="md-option md-option--clickable" onClick={() => onOption(item)}>
                                    {item}
                                </button>
                            ) : (
                                <div key={j} className="md-option">{item}</div>
                            )))}
                        </div>
                    );
                }
                return (
                    <ReactMarkdown
                        key={index}
                        remarkPlugins={REMARK_PLUGINS}
                        rehypePlugins={REHYPE_PLUGINS}
                        urlTransform={safeUrlTransform}
                        components={components}
                    >
                        {segment.text}
                    </ReactMarkdown>
                );
            })}
        </div>
    ), [segments, components, onOption]);
}

/**
 * 会话级的路径白名单 provider（B-145 finding 2）。
 *
 * **必须挂在会话根上（ChatList），不是每条消息各挂一个。** 第一版挂在 `Markdown`
 * 里，于是每条消息各自 `useSessionMessages`（订阅整个数组）+ 各扫一遍全量消息 →
 * 长会话 O(N²)。白名单本来就是**会话级**的事实，挂一次就够。
 */
export function MarkdownPathProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
    const { messages } = useSessionMessages(sessionId);
    // B-311: `messages` gets a new identity on every applyMessages, so the
    // memo below rebuilt the context value on every incoming message even
    // though the allowlist almost never changes — and a new context value
    // re-renders EVERY TextLeaf/FilePathLink in the transcript. Keep the
    // previous value whenever the set of paths is unchanged. (Writing the ref
    // during render is safe here: the computation is pure and a double
    // invocation produces the identical signature.)
    const cache = React.useRef<{ signature: string; value: { sessionId: string; allowlist: Set<string> } } | null>(null);
    const value = React.useMemo(() => {
        const allowlist = collectSessionFilePaths(messages);
        const signature = `${sessionId} :: ${[...allowlist].sort().join('\n')}`;
        if (cache.current?.signature === signature) return cache.current.value;
        const next = { sessionId, allowlist };
        cache.current = { signature, value: next };
        return next;
    }, [sessionId, messages]);
    return <PathLinkContext.Provider value={value}>{children}</PathLinkContext.Provider>;
}
