/**
 * Tiny dependency-free markdown renderer → React nodes.
 *
 * Supports the subset agent text actually uses: headings, paragraphs, bold,
 * italic, inline code, fenced code blocks, unordered/ordered lists, blockquotes,
 * links, and horizontal rules. We render to real DOM nodes (no
 * dangerouslySetInnerHTML) so untrusted text can never inject markup.
 *
 * This is intentionally small — not CommonMark-complete — and good enough for
 * the borderless agent-text bubbles. Fenced code blocks reuse CodeView.
 */
import React from 'react';
import { CodeView } from './CodeView';
import './markdown.css';
import { FilePathLink } from './FilePathLink';
import { collectSessionFilePaths, findPathHits } from './toolFilePath';
import { useSessionMessages } from '@/sync/storage';

type Block =
    | { type: 'heading'; level: number; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'code'; lang: string | null; code: string }
    | { type: 'list'; ordered: boolean; items: string[] }
    | { type: 'quote'; text: string }
    | { type: 'options'; items: string[] }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'hr' };

function parseBlocks(src: string): Block[] {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const blocks: Block[] = [];
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];

        // Fenced code block
        const fence = line.match(/^\s*```(.*)$/);
        if (fence) {
            const lang = fence[1].trim() || null;
            const code: string[] = [];
            i++;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
                code.push(lines[i]);
                i++;
            }
            i++; // skip closing fence
            blocks.push({ type: 'code', lang, code: code.join('\n') });
            continue;
        }

        // Blank line
        if (/^\s*$/.test(line)) {
            i++;
            continue;
        }

        // Horizontal rule
        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
            blocks.push({ type: 'hr' });
            i++;
            continue;
        }

        // Heading
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
            i++;
            continue;
        }

        // Options block: <options><option>..</option>..</options>
        if (/^\s*<options>/.test(line)) {
            const items: string[] = [];
            i++;
            while (i < lines.length && !/^\s*<\/options>/.test(lines[i])) {
                const om = lines[i].match(/<option>([\s\S]*?)<\/option>/);
                if (om) items.push(om[1].trim());
                i++;
            }
            i++; // skip closing tag
            if (items.length > 0) blocks.push({ type: 'options', items });
            continue;
        }

        // Table: a line with '|' followed by a separator row of dashes.
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
            const splitRow = (l: string): string[] => {
                let cells = l.trim().split('|').map((c) => c.trim());
                if (cells.length && cells[0] === '') cells = cells.slice(1);
                if (cells.length && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
                return cells;
            };
            const headers = splitRow(line);
            i += 2; // header + separator
            const rows: string[][] = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(splitRow(lines[i]));
                i++;
            }
            blocks.push({ type: 'table', headers, rows });
            continue;
        }

        // Blockquote
        if (/^\s*>\s?/.test(line)) {
            const quote: string[] = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            blocks.push({ type: 'quote', text: quote.join('\n') });
            continue;
        }

        // Lists
        const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
        const olMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ulMatch || olMatch) {
            const ordered = !!olMatch;
            const items: string[] = [];
            while (i < lines.length) {
                const ul = lines[i].match(/^\s*[-*+]\s+(.*)$/);
                const ol = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
                if (ordered && ol) {
                    items.push(ol[1]);
                    i++;
                } else if (!ordered && ul) {
                    items.push(ul[1]);
                    i++;
                } else {
                    break;
                }
            }
            blocks.push({ type: 'list', ordered, items });
            continue;
        }

        // Paragraph — gather consecutive non-blank, non-structural lines
        const para: string[] = [];
        while (i < lines.length) {
            const l = lines[i];
            if (
                /^\s*$/.test(l) ||
                /^\s*```/.test(l) ||
                /^(#{1,6})\s+/.test(l) ||
                /^\s*>\s?/.test(l) ||
                /^\s*[-*+]\s+/.test(l) ||
                /^\s*\d+[.)]\s+/.test(l) ||
                /^\s*<options>/.test(l) ||
                /^\s*(?:---|\*\*\*|___)\s*$/.test(l)
            ) {
                break;
            }
            para.push(l);
            i++;
        }
        if (para.length) {
            blocks.push({ type: 'paragraph', text: para.join('\n') });
        }
    }

    return blocks;
}

// Inline tokenizer: code spans first (so their contents are not re-parsed),
// then bold/italic/links over the remaining text.
let keyCounter = 0;
function nextKey() {
    return `md${keyCounter++}`;
}

function renderInline(text: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Split on inline code spans, keep delimiters.
    const parts = text.split(/(`[^`]+`)/g);
    for (const part of parts) {
        if (!part) continue;
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            // B-145 finding 1：反引号是 claude 写路径的**默认形式**
            // （「已写入 `docs/report.md`」），所以代码段内容也必须过 TextLeaf。
            // 原来这里直接输出原文，导致功能在主场景下完全不生效。
            nodes.push(
                <code key={nextKey()} className="md-code-inline">
                    <TextLeaf text={part.slice(1, -1)} />
                </code>,
            );
        } else {
            nodes.push(...renderEmphasis(part));
        }
    }
    return nodes;
}

function renderEmphasis(text: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Links: [label](url)
    const linkRe = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(text)) !== null) {
        if (m.index > last) {
            nodes.push(...renderBoldItalic(text.slice(last, m.index)));
        }
        const href = m[2];
        const safe = /^(https?:|mailto:)/i.test(href) ? href : undefined;
        nodes.push(
            <a key={nextKey()} href={safe} target="_blank" rel="noopener noreferrer" className="md-link">
                {/* B-145 finding 3：label 里禁用路径链接。<button> 嵌 <a> 是非法嵌套，
                    且 stopPropagation 只挡 React 合成事件、浏览器仍会走 anchor 默认
                    导航——点一次会同时开预览并把标签页导航走。 */}
                <NoPathLinks>{renderBoldItalic(m[1])}</NoPathLinks>
            </a>,
        );
        last = linkRe.lastIndex;
    }
    if (last < text.length) {
        nodes.push(...renderBoldItalic(text.slice(last)));
    }
    return nodes;
}

/**
 * B-145: 让正文里的文件路径可点。
 *
 * 只对**本会话工具调用碰过的路径**生效（白名单，见 toolFilePath.ts）——不用正则猜，
 * 因为自由文本里认路径必然假阳性，而点了没反应比没链接更烦。
 *
 * 实现上把切口放在**叶子**：`renderInline` 在本文件里有 11 个调用点，透传参数会把
 * 整个渲染管线搅一遍；而叶子换成组件后自己读 context 即可，改动面 = 两行。
 */
interface PathLinkCtx { sessionId: string; allowlist: ReadonlySet<string> }
const PathLinkContext = React.createContext<PathLinkCtx | null>(null);

/** 在这棵子树里关掉路径链接（用于 markdown 链接的 label，见 finding 3；
 *  B-309 的流式草稿也用它——每帧对每个叶子跑一遍 `findPathHits` 纯属浪费，
 *  1.5 秒后落地的持久化消息照样会把路径链上）。 */
export function NoPathLinks({ children }: { children: React.ReactNode }) {
    return <PathLinkContext.Provider value={null}>{children}</PathLinkContext.Provider>;
}

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

function renderBoldItalic(text: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Bold (**x** / __x__) then italic (*x* / _x_)
    const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) nodes.push(<TextLeaf key={nextKey()} text={text.slice(last, m.index)} />);
        if (m[1]) {
            nodes.push(<strong key={nextKey()}>{m[2]}</strong>);
        } else {
            nodes.push(<em key={nextKey()}>{m[4]}</em>);
        }
        last = re.lastIndex;
    }
    if (last < text.length) nodes.push(<TextLeaf key={nextKey()} text={text.slice(last)} />);
    return nodes;
}

export function Markdown({ text, onOption, plainCode = false }: {
    text: string;
    onOption?: (option: string) => void;
    /** B-309: render fenced code without highlighting (streaming drafts). */
    plainCode?: boolean;
}) {
    const blocks = React.useMemo(() => parseBlocks(text), [text]);
    const body = (
        <div className="md">
            {blocks.map((b, idx) => {
                switch (b.type) {
                    case 'heading': {
                        const Tag = `h${Math.min(b.level, 6)}` as keyof React.JSX.IntrinsicElements;
                        return (
                            <Tag key={idx} className={`md-h md-h${b.level}`}>
                                {renderInline(b.text)}
                            </Tag>
                        );
                    }
                    case 'paragraph':
                        return (
                            <p key={idx} className="md-p">
                                {renderInline(b.text)}
                            </p>
                        );
                    case 'code':
                        return <CodeView key={idx} code={b.code} lang={b.lang} plain={plainCode} />;
                    case 'list':
                        return b.ordered ? (
                            <ol key={idx} className="md-ol">
                                {b.items.map((it, j) => (
                                    <li key={j}>{renderInline(it)}</li>
                                ))}
                            </ol>
                        ) : (
                            <ul key={idx} className="md-ul">
                                {b.items.map((it, j) => (
                                    <li key={j}>{renderInline(it)}</li>
                                ))}
                            </ul>
                        );
                    case 'quote':
                        return (
                            <blockquote key={idx} className="md-quote">
                                {renderInline(b.text)}
                            </blockquote>
                        );
                    case 'options':
                        return (
                            <div key={idx} className="md-options">
                                {b.items.map((it, j) =>
                                    onOption ? (
                                        <button
                                            key={j}
                                            type="button"
                                            className="md-option md-option--clickable"
                                            onClick={() => onOption(it)}
                                        >
                                            {renderInline(it)}
                                        </button>
                                    ) : (
                                        <div key={j} className="md-option">
                                            {renderInline(it)}
                                        </div>
                                    ),
                                )}
                            </div>
                        );
                    case 'table':
                        return (
                            <div key={idx} className="md-table-wrap">
                                <table className="md-table">
                                    <thead>
                                        <tr>
                                            {b.headers.map((h, j) => (
                                                <th key={j}>{renderInline(h)}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {b.rows.map((row, ri) => (
                                            <tr key={ri}>
                                                {row.map((cell, ci) => (
                                                    <td key={ci}>{renderInline(cell)}</td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        );
                    case 'hr':
                        return <hr key={idx} className="md-hr" />;
                    default:
                        return null;
                }
            })}
        </div>
    );
    return body;
}

/**
 * 会话级的路径白名单 provider（B-145 finding 2）。
 *
 * **必须挂在会话根上（ChatList），不是每条消息各挂一个。** 第一版挂在 `Markdown`
 * 里，于是每条消息各自 `useSessionMessages`（订阅整个数组）+ 各扫一遍全量消息 →
 * 长会话 O(N²)；而且 agent 流式追加时数组 identity 变，N 个 provider 全部重算、
 * ctx identity 变又让全 transcript 每个 TextLeaf 的 useMemo 失效。白名单本来就是
 * **会话级**的事实，挂一次就够。
 */
export function MarkdownPathProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
    const { messages } = useSessionMessages(sessionId);
    // B-311: `messages` gets a new identity on every applyMessages, so the
    // memo above rebuilt the context value on every incoming message even
    // though the allowlist almost never changes — and a new context value
    // re-renders EVERY TextLeaf/FilePathLink in the transcript. Keep the
    // previous value whenever the set of paths is unchanged. (Writing the ref
    // during render is safe here: the computation is pure and a double
    // invocation produces the identical signature.)
    const cache = React.useRef<{ signature: string; value: { sessionId: string; allowlist: Set<string> } } | null>(null);
    const value = React.useMemo(() => {
        const allowlist = collectSessionFilePaths(messages);
        const signature = `${sessionId}\u0000${[...allowlist].sort().join('\n')}`;
        if (cache.current?.signature === signature) return cache.current.value;
        const next = { sessionId, allowlist };
        cache.current = { signature, value: next };
        return next;
    }, [sessionId, messages]);
    return <PathLinkContext.Provider value={value}>{children}</PathLinkContext.Provider>;
}
