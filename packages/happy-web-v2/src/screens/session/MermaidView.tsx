/**
 * ```mermaid 代码块 → 真图（B-358）。
 *
 * 设计原则：**屏幕上任何时刻都必须有内容**。mermaid 及其依赖是懒加载的（首图 171 kB gzip），
 * 而 LLM 写错 mermaid 语法是常态，所以这里是一个状态机，每一格都落在「代码块」这个安全底：
 *
 * | 状态 | 显示 |
 * |---|---|
 * | 加载中 / 未渲染 | `CodeView`（不是 spinner，不是空白） |
 * | 成功 | SVG + 右上角「展开」与 ⋯ 菜单（复制源码 / 下载 SVG / 下载 PNG / 查看源码，B-890） |
 * | 语法错或渲染失败 | 回落 `CodeView` + 一行 dim 说明；**不显示 mermaid 自己的错误图** |
 * | 弱网（saveData / 2g-3g） | `CodeView` + 「渲染图表」按钮，把 171 kB 的决定权交给用户 |
 *
 * 失败、加载中、弱网这几格都**没有**展开和 ⋯ 菜单：没有图就没有可以放大或下载的东西。
 *
 * 流式草稿（`plainCode`）根本不会走到这里——半截图必然解析失败，而草稿每秒重渲多次
 * （见 `Markdown.tsx` 的 `components.pre`）。
 */
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, Code2, Copy, Download, FileImage, Image as ImageIcon, Maximize2, MoreHorizontal } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { ImagePreview } from '@/components/ImagePreview';
import { ActionDropdownMenu, type MenuItemDef } from '@/ui/Menu';
import { CodeView } from './CodeView';
import { renderMermaid, sanitizeMermaidId, shouldDeferMermaid } from './mermaidRender';
import {
    MERMAID_FILE_BASENAME, diagramBackground, downloadBlob, exportFontCss, standaloneSvg, svgBlob, svgToPngBlob, type StandaloneSvg,
} from './mermaidExport';
import './mermaid.css';

/**
 * 当前生效的主题，不依赖 `ThemeProvider`。
 *
 * `useTheme()` 在 provider 之外会抛，而 `<Markdown>` 也被 `renderToStaticMarkup` 的测试
 * 直接渲染；这里读 DOM + matchMedia 并订阅两者的变化，行为等价而没有耦合。
 */
function useThemeKey(): string {
    const read = () => {
        if (typeof document === 'undefined') return 'dark';
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'dark' || attr === 'light') return attr;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    };
    const [key, setKey] = useState(read);
    useEffect(() => {
        const update = () => setKey(read());
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
        mq?.addEventListener('change', update);
        const mo = typeof MutationObserver !== 'undefined'
            ? new MutationObserver(update)
            : null;
        mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => { mq?.removeEventListener('change', update); mo?.disconnect(); };
    }, []);
    return key;
}

type State =
    | { kind: 'idle' }
    | { kind: 'ok'; svg: string }
    | { kind: 'failed' };

export function MermaidView({ code }: { code: string }) {
    const { t } = useTranslation();
    const themeKey = useThemeKey();
    const id = sanitizeMermaidId(useId());
    // `armed` is STATE, not a ref, and it is in the effect's deps. A ref cannot
    // work here: flipping it does not re-run the effect, so the slow-network
    // button used to arm nothing — it just re-rendered into the fallback branch,
    // removing itself and leaving the diagram permanently unrendered (measured:
    // renderCalls stayed 0 after the click). It only ever goes false → true, so
    // there is no loop.
    const [deferred] = useState(shouldDeferMermaid);
    const [armed, setArmed] = useState(() => !shouldDeferMermaid());
    const [state, setState] = useState<State>({ kind: 'idle' });
    const [showSource, setShowSource] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const attempt = useRef(0);
    const svg = state.kind === 'ok' ? state.svg : null;
    const actions = useDiagramActions(code, svg);

    useEffect(() => {
        if (!armed) return;
        let cancelled = false;
        // StrictMode mounts the effect twice; without a per-attempt suffix both
        // runs render into the same mermaid id, and mermaid's temporary
        // `#d<id>` node is fought over by the two in-flight renders.
        attempt.current += 1;
        void renderMermaid(`${id}-${attempt.current}`, code, themeKey).then((result) => {
            if (cancelled) return;
            setState(result.ok ? { kind: 'ok', svg: result.svg } : { kind: 'failed' });
        });
        return () => { cancelled = true; };
    }, [code, themeKey, id, armed]);

    // The slow-network branch keeps its button through the download instead of
    // removing it: this path only runs on saveData / 2g-3g (and Chrome reports a
    // high-latency wifi as 3g), where fetching mermaid can take many seconds. A
    // button that vanishes on click reads as "nothing happened".
    if (!armed || (deferred && state.kind === 'idle')) {
        const loading = armed;
        return (
            <div className="mmd">
                <CodeView code={code} lang="mermaid" />
                <button
                    type="button"
                    className="mmd-action"
                    disabled={loading}
                    onClick={() => setArmed(true)}
                >
                    <ImageIcon size={13} aria-hidden />
                    {loading ? t('session.chat.mermaidLoading') : t('session.chat.mermaidRender')}
                </button>
            </div>
        );
    }

    if (state.kind === 'ok' && !showSource) {
        return (
            <div className="mmd">
                {/* mermaid 产物是 SVG 字符串，只能这样注入。安全性靠 securityLevel:'strict'
                    （禁 click 处理器与原始 HTML 标签）+ mermaid 内部的 dompurify，见
                    mermaidRender.ts 与 mermaidSecurity.test.tsx。 */}
                <div className="mmd-frame">
                    <div className="mmd-svg" onClick={(event) => { if (!hasTextSelection(event)) setFullscreen(true); }}
                        dangerouslySetInnerHTML={{ __html: state.svg }} />
                    <div className="mmd-tools">
                        <button type="button" className="mmd-tool" aria-haspopup="dialog" onClick={() => setFullscreen(true)}
                            title={t('session.chat.mermaidExpand')} aria-label={t('session.chat.mermaidExpand')}>
                            <Maximize2 size={14} aria-hidden />
                        </button>
                        <ActionDropdownMenu items={actions.menuItems(() => setShowSource(true))}>
                            <button type="button" className="mmd-tool" title={t('session.chat.mermaidMore')} aria-label={t('session.chat.mermaidMore')}>
                                <MoreHorizontal size={14} aria-hidden />
                            </button>
                        </ActionDropdownMenu>
                    </div>
                </div>
                <span className="mmd-note" role="status">{actions.status ?? ''}</span>
                {fullscreen && <MermaidFullscreen actions={actions} onClose={() => setFullscreen(false)} />}
            </div>
        );
    }

    return (
        <div className="mmd">
            <CodeView code={code} lang="mermaid" />
            {state.kind === 'ok' && (
                <button type="button" className="mmd-action" onClick={() => setShowSource(false)}>
                    <ImageIcon size={13} aria-hidden />
                    {t('session.chat.mermaidDiagram')}
                </button>
            )}
            {state.kind === 'failed' && <span className="mmd-note">{t('session.chat.mermaidFailed')}</span>}
        </div>
    );
}

/** A drag that selected label text is not a click on the diagram. */
function hasTextSelection(event: ReactMouseEvent): boolean {
    const selection = event.currentTarget.ownerDocument.getSelection();
    return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

type DiagramActions = ReturnType<typeof useDiagramActions>;

/**
 * B-890: copy / SVG / PNG for the rendered diagram — one set shared by the ⋯ menu
 * and the full-screen header so they cannot drift. Feedback is an inline status
 * line, not a toast: the anonymous share page (`PublicRoot`) has no ToastProvider,
 * and a silent no-op toast there would read as "nothing happened".
 */
function useDiagramActions(code: string, svg: string | null) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<{ text: string; copied: boolean } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const flash = (text: string, copied = false) => {
        setStatus({ text, copied });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus(null), copied ? 1800 : 4000);
    };
    // The embedded font is fetched once a diagram exists; until it arrives the
    // viewer shows the export without it, and the downloads wait for it.
    const [fontCss, setFontCss] = useState<string | null>(null);
    useEffect(() => {
        if (!svg) return;
        let live = true;
        void exportFontCss().then((css) => { if (live) setFontCss(css); });
        return () => { live = false; };
    }, [svg]);
    // Re-exported whenever the SVG changes (a theme switch re-renders it with new colours).
    const standalone = useMemo<StandaloneSvg | null>(() => (svg ? standaloneSvg(svg, diagramBackground(), fontCss) : null), [svg, fontCss]);
    const exportNow = async () => (svg ? standaloneSvg(svg, diagramBackground(), await exportFontCss()) : null);

    const copySource = async () => {
        try {
            await navigator.clipboard.writeText(code);
            flash(t('session.chat.mermaidCopied'), true);
        } catch {
            flash(t('session.chat.mermaidCopyFailed'));
        }
    };
    const downloadSvg = async () => {
        const file = await exportNow();
        if (file) downloadBlob(svgBlob(file.svg), `${MERMAID_FILE_BASENAME}.svg`);
    };
    const downloadPng = async () => {
        try {
            const file = await exportNow();
            if (file) downloadBlob(await svgToPngBlob(file, window.devicePixelRatio || 1), `${MERMAID_FILE_BASENAME}.png`);
        } catch (error) {
            console.error('[mermaid] png export failed', error);
            flash(t('session.chat.mermaidPngFailed'));
        }
    };
    const menuItems = (viewSource: () => void): MenuItemDef[] => [
        { key: 'copy', label: t('session.chat.mermaidCopySource'), icon: Copy, onSelect: () => { void copySource(); } },
        { key: 'svg', label: t('session.chat.mermaidDownloadSvg'), icon: Download, disabled: !standalone, onSelect: () => { void downloadSvg(); } },
        { key: 'png', label: t('session.chat.mermaidDownloadPng'), icon: FileImage, disabled: !standalone, onSelect: () => { void downloadPng(); } },
        { key: 'source', label: t('session.chat.mermaidSource'), icon: Code2, separatorBefore: true, onSelect: viewSource },
    ];
    return { standalone, copySource, downloadSvg, downloadPng, menuItems, status: status?.text ?? null, copied: !!status?.copied };
}

/**
 * Full-screen viewer: the image preview's pan / wheel / pinch / double-tap zoom,
 * fit (reset) and Esc, on the standalone SVG — one gesture model for every image
 * in the app instead of a second one for diagrams.
 */
function MermaidFullscreen({ actions, onClose }: { actions: DiagramActions; onClose: () => void }) {
    const { t } = useTranslation();
    const svg = actions.standalone?.svg;
    const url = useMemo(() => (svg ? URL.createObjectURL(svgBlob(svg)) : null), [svg]);
    useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
    if (!url) return null;
    const copyLabel = actions.copied ? t('session.chat.mermaidCopied') : t('session.chat.mermaidCopySource');
    return (
        <ImagePreview
            src={url}
            title={t('session.chat.mermaidFullscreenTitle')}
            download={false}
            onClose={onClose}
            actions={<>
                {actions.status && !actions.copied && <span className="mmd-full-status" role="status">{actions.status}</span>}
                <button type="button" className="image-preview-button" onClick={() => { void actions.copySource(); }} title={copyLabel} aria-label={copyLabel}>
                    {actions.copied ? <Check size={17} aria-hidden /> : <Copy size={17} aria-hidden />}
                </button>
                <button type="button" className="image-preview-button" onClick={() => { void actions.downloadSvg(); }}
                    title={t('session.chat.mermaidDownloadSvg')} aria-label={t('session.chat.mermaidDownloadSvg')}>
                    <Download size={17} aria-hidden /><span>SVG</span>
                </button>
                <button type="button" className="image-preview-button" onClick={() => { void actions.downloadPng(); }}
                    title={t('session.chat.mermaidDownloadPng')} aria-label={t('session.chat.mermaidDownloadPng')}>
                    <Download size={17} aria-hidden /><span>PNG</span>
                </button>
            </>}
        />
    );
}
