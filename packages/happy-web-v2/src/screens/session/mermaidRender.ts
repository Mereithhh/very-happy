/**
 * mermaid 的懒加载与渲染（B-357）—— 纯逻辑，不含 React。
 *
 * **为什么必须懒加载**：mermaid 11 拖着 d3 / cytoscape / katex / roughjs 等 22 个依赖。
 * 实测把它接进构建：JS chunk 48 → 108、`dist/assets` 7.1M → 11M、全部 JS gzip 合计
 * 1551.5 → 2500.6 kB，首张 flowchart 要下 `mermaid.core` 171 kB gzip 加图类型分包。
 * 本机语料里 mermaid 出现 **0 次**——一个几乎不出现的功能绝不能让每个人都付这份钱。
 * 所以入口只有一个动态 `import()`，Vite 会把它切进独立 async chunk（先例 `highlighter.ts`）。
 * 注意：「AppRoot 的 gzip 没变大」证明不了任何事（动态 import 必然如此），要看的是 chunk 清单。
 *
 * **为什么先 `parse` 再 `render`**（实测 mermaid 11.17.2）：`parse` 不需要 DOM，
 * `{ suppressErrors: true }` 时坏语法返回 `false` 而不抛；`render` 需要 `document`，
 * 且失败时会把 mermaid 自己的红色错误图**插进页面**。LLM 写错 mermaid 语法是常态，
 * 所以坏语法必须在 `render` 之前就被拦下来，正文里只回落成代码块。
 */

export type MermaidResult =
    | { ok: true; svg: string }
    | { ok: false; reason: 'syntax' | 'render' | 'load' };

type MermaidModule = typeof import('mermaid')['default'];

let modulePromise: Promise<MermaidModule | null> | null = null;
let loadFailed = false;

if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        if (!loadFailed) return;
        loadFailed = false;
        // The failed promise resolved to null and would be handed out forever.
        modulePromise = null;
    });
}
let initializedTheme: string | null = null;

/** 从 tokens 读色，避免在这里写死颜色（tokens.css 头部：组件里禁止裸色值）。 */
function themeVariables(): Record<string, string> {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    // --line-2 rather than --line for shape outlines: on the light theme --line on
    // --bg-2 is a 5/255 difference and the boxes read as missing.
    const line = v('--line-2', '#41433d');
    const text = v('--text', '#ecede8');
    const dim = v('--text-dim', '#b2b4ad');
    return {
        background: v('--bg-1', '#171815'),
        primaryColor: v('--bg-2', '#20211e'),
        primaryTextColor: text,
        primaryBorderColor: line,
        secondaryColor: v('--bg-3', '#292a26'),
        tertiaryColor: v('--bg-0', '#111210'),
        lineColor: v('--line-2', '#41433d'),
        textColor: text,
        mainBkg: v('--bg-2', '#20211e'),
        nodeBorder: line,
        clusterBkg: v('--bg-1', '#171815'),
        clusterBorder: line,
        titleColor: text,
        edgeLabelBackground: v('--bg-1', '#171815'),
        labelTextColor: text,
        noteBkgColor: v('--bg-3', '#292a26'),
        noteTextColor: dim,
        noteBorderColor: line,
        fontFamily: v('--font-sans', 'system-ui, sans-serif'),
        fontSize: '13px',
    };
}

async function loadMermaid(): Promise<MermaidModule | null> {
    // One attempt per page. Clearing `modulePromise` on failure would make every
    // remaining diagram fetch the 171 kB chunk again — offline with five diagrams
    // is five failed requests, and the second one never succeeds where the first
    // did not. Same "retry once, then fall back" rule as the attachment previews.
    // The `online` listener below is what keeps that from being permanent: this is
    // a PWA that stays open for hours, so "went through a tunnel once" must not
    // cost the rest of the session.
    if (loadFailed) return null;
    if (!modulePromise) {
        modulePromise = import('mermaid')
            .then((m) => m.default)
            .catch((error) => {
                console.error('[mermaid] failed to load', error);
                loadFailed = true;
                return null;
            });
    }
    return modulePromise;
}

/**
 * 渲染一张图。`themeKey` 变化时会重新 `initialize`（主题切换要换配色）。
 * 任何失败都返回 `ok:false`，调用方负责回落成代码块——这里绝不抛。
 */
export async function renderMermaid(id: string, code: string, themeKey: string): Promise<MermaidResult> {
    const mermaid = await loadMermaid();
    if (!mermaid) return { ok: false, reason: 'load' };

    if (initializedTheme !== themeKey) {
        mermaid.initialize({
            startOnLoad: false,
            // 'strict' 禁掉 click 处理器与原始 HTML 标签；mermaid 内部还会过一遍 dompurify。
            // 这是本仓第二处 dangerouslySetInnerHTML（第一处是 shiki），安全性靠这两条。
            securityLevel: 'strict',
            // 关掉「渲染失败就往 DOM 里插一张红色错误图」——正文里只回落代码块。
            suppressErrorRendering: true,
            theme: 'base',
            themeVariables: themeVariables(),
            flowchart: { htmlLabels: false },
            ...(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
                ? { sequence: { actorFontSize: 13 } }
                : {}),
        });
        initializedTheme = themeKey;
    }

    try {
        // parse first: it needs no DOM and returns false (rather than throwing)
        // for bad syntax, so a broken diagram never reaches render().
        const valid = await mermaid.parse(code, { suppressErrors: true });
        if (!valid) return { ok: false, reason: 'syntax' };
    } catch {
        return { ok: false, reason: 'syntax' };
    }

    try {
        const { svg } = await mermaid.render(id, code);
        return { ok: true, svg };
    } catch (error) {
        console.error('[mermaid] render failed', error);
        return { ok: false, reason: 'render' };
    }
}

/**
 * 弱网时不自动下载 171 kB：把「要不要出图」交给用户。
 * `navigator.connection` 只有 Chromium 系有，缺失时按「网络没问题」处理。
 */
export function shouldDeferMermaid(): boolean {
    const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!conn) return false;
    if (conn.saveData) return true;
    return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g';
}

/** mermaid 拿这个 id 去 `querySelector`，而 React 19 的 `useId()` 形如 `«r1»` —— 会抛。 */
export function sanitizeMermaidId(id: string): string {
    const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '');
    return `mmd-${cleaned || '0'}`;
}

/** 测试用：忘掉已加载的模块与主题，让下一次渲染重新走一遍。 */
export function resetMermaidForTest() {
    modulePromise = null;
    initializedTheme = null;
    loadFailed = false;
}
