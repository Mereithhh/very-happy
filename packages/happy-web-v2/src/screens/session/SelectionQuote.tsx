/**
 * B-577 —— 选中消息文字后的「引用」。
 *
 * 桌面（pointer: fine）：选区上方浮出一个按钮，点击把选中文字插到输入框光标处。
 * 触屏：不画浮层（系统选区菜单在那里），选区静止 500ms 后交给该消息的操作栏
 * （selectionQuoteOffer → MessageActions 的「引用选中」）。
 *
 * 时机参考 Orca `NativeChatSelectionQuote`（MIT）：双击后等 500ms 再出，免得第三击正好
 * 落到按钮上；按钮 mousedown 阻止默认，点击不丢选区。
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Quote } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { isMirrorSession } from '@/assistant/assistantSession';
import { useTranslation } from '@/i18n/useTranslation';
import { quoteMessage } from './messageQuote';
import { readQuotableSelection } from './selectionQuoteRange';
import { setTouchQuoteOffer } from './selectionQuoteOffer';

/** 双击之后再等这么久，第三击才不会点到按钮。触屏选区也要静止这么久才算选好。 */
export const SELECTION_SETTLE_MS = 500;
const BUTTON_GAP = 6;
const BUTTON_HEIGHT = 30;

type Request = {
    text: string;
    range: Range;
    /** 锚点相对 range 外接矩形左上角的偏移，滚动时跟着文字走。 */
    dx: number;
    dy: number;
};
type Position = { left: number; top: number; below: boolean } | null;

function isCoarse(): boolean {
    return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

export function SelectionQuote({ rootRef, sessionId }: { rootRef: RefObject<HTMLElement | null>; sessionId: string }) {
    const session = useSession(sessionId);
    const enabled = !!session && !isMirrorSession(session);
    const { t } = useTranslation();
    const [request, setRequest] = useState<Request | null>(null);
    const [position, setPosition] = useState<Position>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const requestRef = useRef<Request | null>(null);
    requestRef.current = request;

    // 跟着选区定位；选区滚出 transcript 可视区就隐藏。
    const place = (current: Request | null) => {
        const root = rootRef.current;
        if (!current || !root) { setPosition(null); return; }
        const box = current.range.getBoundingClientRect();
        const view = root.getBoundingClientRect();
        const x = box.left + current.dx;
        const y = box.top + current.dy;
        if (y < view.top || y > view.bottom || (box.width === 0 && box.height === 0)) { setPosition(null); return; }
        const below = y - BUTTON_GAP - BUTTON_HEIGHT < view.top;
        const lineBottom = (() => {
            const rects = [...current.range.getClientRects()];
            const line = rects.find((r) => y >= r.top - 1 && y <= r.bottom + 1) ?? rects[rects.length - 1];
            return line ? line.bottom : y;
        })();
        const width = buttonRef.current?.offsetWidth ?? 72;
        const left = Math.min(Math.max(view.left + 8, x - width / 2), view.right - width - 8);
        setPosition({ left, top: below ? lineBottom + BUTTON_GAP : y - BUTTON_GAP - BUTTON_HEIGHT, below });
    };

    useEffect(() => {
        const root = rootRef.current;
        if (!enabled || !root) return;
        let selectionChanged = false;
        // What was selected when the button went down: a press that leaves it
        // as it was (a scrollbar, a timestamp) selected nothing. The flag alone
        // misses a double-click — its word selection lands on mousedown, and
        // the selectionchange event may only arrive after mouseup.
        let textAtPress = '';
        let timer: number | undefined;
        let touchTimer: number | undefined;
        let raf = 0;
        const close = () => {
            window.clearTimeout(timer);
            setRequest(null);
            setPosition(null);
        };
        const offer = (point: { x: number; y: number } | null, delay: number) => {
            const unchanged = !selectionChanged && (window.getSelection()?.toString() ?? '') === textAtPress;
            selectionChanged = false;
            if (unchanged) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const selection = window.getSelection();
                let quotable = readQuotableSelection(root, selection);
                if (quotable?.clipped && selection) {
                    // 越过了起点消息：把选区收回到起点消息内，所见即所引。
                    selection.removeAllRanges();
                    selection.addRange(quotable.range);
                    quotable = readQuotableSelection(root, selection) ?? quotable;
                }
                if (!quotable) { close(); return; }
                const range = quotable.range;
                const box = range.getBoundingClientRect();
                const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
                const end = rects[rects.length - 1] ?? box;
                // 鼠标松开处那一行的顶部；键盘选区用终点那一行。
                const line = point ? rects.find((r) => point.y >= r.top - 2 && point.y <= r.bottom + 2) ?? end : end;
                const x = point ? Math.min(Math.max(point.x, line.left), line.right) : end.right;
                const next: Request = { text: quotable.text, range, dx: x - box.left, dy: line.top - box.top };
                setRequest(next);
                place(next);
            }, delay);
        };
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && buttonRef.current?.contains(event.target)) return;
            close();
            selectionChanged = false;
            textAtPress = window.getSelection()?.toString() ?? '';
        };
        const onMouseUp = (event: MouseEvent) => {
            if (event.button !== 0 || isCoarse()) return;
            offer({ x: event.clientX, y: event.clientY }, event.detail === 2 ? SELECTION_SETTLE_MS : 0);
        };
        const onKeyUp = (event: KeyboardEvent) => {
            if (isCoarse()) return;
            if (event.key === 'Escape') { close(); return; }
            offer(null, 0);
        };
        const onSelectionChange = () => {
            selectionChanged = true;
            const current = requestRef.current;
            if (current) {
                const now = readQuotableSelection(root, window.getSelection());
                if (now?.text !== current.text) close();
            }
            if (isCoarse()) {
                window.clearTimeout(touchTimer);
                touchTimer = window.setTimeout(() => {
                    const quotable = readQuotableSelection(root, window.getSelection());
                    // 触屏不改用户的选区：跨消息就不提供。
                    setTouchQuoteOffer(quotable && !quotable.clipped ? { source: quotable.source, text: quotable.text } : null);
                }, SELECTION_SETTLE_MS);
            }
        };
        const onScroll = () => {
            if (!requestRef.current || raf) return;
            raf = requestAnimationFrame(() => { raf = 0; place(requestRef.current); });
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('selectionchange', onSelectionChange);
        window.addEventListener('mouseup', onMouseUp);
        document.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', close);
        window.addEventListener('resize', close);
        root.addEventListener('scroll', onScroll, { passive: true });
        // The transcript resizing (keyboard, side panel, composer growing)
        // moves the text without a scroll: re-place, or hide once it is gone.
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll);
        resize?.observe(root);
        if (root.firstElementChild) resize?.observe(root.firstElementChild);
        return () => {
            resize?.disconnect();
            close();
            window.clearTimeout(touchTimer);
            if (raf) cancelAnimationFrame(raf);
            setTouchQuoteOffer(null);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('selectionchange', onSelectionChange);
            window.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', close);
            window.removeEventListener('resize', close);
            root.removeEventListener('scroll', onScroll);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- place reads refs only
    }, [enabled, rootRef]);

    if (!request || typeof document === 'undefined') return null;
    return createPortal(
        <button
            ref={buttonRef}
            type="button"
            className="cl-selquote"
            style={position ? { left: position.left, top: position.top } : { visibility: 'hidden', left: 0, top: 0 }}
            title={t('session.chat.readingAids.quoteSelectionHint')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
                quoteMessage(sessionId, request.text, 'cursor');
                setRequest(null);
                setPosition(null);
            }}
        >
            <Quote size={13} aria-hidden />
            <span>{t('session.chat.readingAids.quoteSelection')}</span>
        </button>,
        document.body,
    );
}
