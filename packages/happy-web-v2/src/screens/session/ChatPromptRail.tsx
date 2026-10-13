/**
 * B-579 —— 「你的提问」导航。
 *
 * 桌面（pointer: fine、右侧留白够宽、≥2 条提问）：对话列右侧一条细刻度轨，每条提问一个刻度，
 * 按在会话中的位置比例分布；悬停/聚焦预览，点击滚到该提问，↑/↓/Home/End 在轨道上跳转。
 * 其他情况（窄屏、触屏）：离开底部时，「跳到最新」上方出现「上一条 / 下一条提问」。
 *
 * 只滚 transcript 自己的容器（scrollTo），不用会滚祖先的 scrollIntoView；系统减少动态效果时不做
 * 平滑滚动。纯逻辑在 chatRail.ts。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronsUp, ChevronUp, ChevronDown } from 'lucide-react';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import type { ChatRow } from './chatTurns';
import { chatReadingAidsCopy } from './chatReadingAidsCopy';
import {
    activeRailIndex,
    adjacentPromptIndex,
    isAtBottom,
    railItemsFromRows,
    railKeyStep,
    railScrollTarget,
    railTickPercent,
    shouldShowRail,
    type RailItem,
} from './chatRail';

type Layout = {
    /** 有 DOM 的条目与其在滚动内容中的 offsetTop（升序）。 */
    items: RailItem[];
    tops: number[];
    total: number;
    gutter: number;
    /** 轨道在 `.cl` 内的上沿与高度（覆盖 transcript 可视区，不压排队 dock）。 */
    railTop: number;
    railHeight: number;
};

const EMPTY: Layout = { items: [], tops: [], total: 0, gutter: 0, railTop: 0, railHeight: 0 };
const RAIL_INSET = 12;
/** 底部留给「跳到最新」（36px + 16px 外边距 + 间隔），两者不重叠。 */
const RAIL_BOTTOM_CLEARANCE = 64;
/** 「更早的消息未加载」占的高度。 */
const OLDER_SLOT = 24;

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function useFinePointer(): boolean {
    const query = '(pointer: fine)';
    const [fine, setFine] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
    useEffect(() => {
        const media = window.matchMedia?.(query);
        if (!media) return;
        const update = () => setFine(media.matches);
        media.addEventListener?.('change', update);
        return () => media.removeEventListener?.('change', update);
    }, []);
    return fine;
}

export function ChatPromptRail({
    rows,
    scrollRef,
    innerRef,
    hasMoreOlder,
    isLoadingOlder,
    sessionId,
    navVisible,
}: {
    rows: ChatRow[];
    scrollRef: RefObject<HTMLDivElement | null>;
    innerRef: RefObject<HTMLDivElement | null>;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
    sessionId: string;
    /** 窄屏按钮的显示条件：离开底部且「跳到最新」在它的老位置（没有排队 dock）。 */
    navVisible: boolean;
}) {
    const { lang } = useTranslation();
    const copy = chatReadingAidsCopy(lang);
    const fine = useFinePointer();
    const allItems = useMemo(() => railItemsFromRows(rows), [rows]);
    const [layout, setLayout] = useState<Layout>(EMPTY);
    const [view, setView] = useState({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
    const [preview, setPreview] = useState<number | null>(null);
    const [focusIndex, setFocusIndex] = useState<number | null>(null);
    const railRef = useRef<HTMLDivElement>(null);

    const measure = useCallback(() => {
        const scroll = scrollRef.current;
        const inner = innerRef.current;
        const lane = scroll?.parentElement;
        if (!scroll || !inner || !lane) return;
        const scrollBox = scroll.getBoundingClientRect();
        const items: RailItem[] = [];
        const tops: number[] = [];
        for (const item of allItems) {
            const el = inner.querySelector(`[data-chat-prompt-id="${CSS.escape(item.id)}"]`);
            if (!el) continue;
            items.push(item);
            tops.push(el.getBoundingClientRect().top - scrollBox.top + scroll.scrollTop);
        }
        const laneBox = lane.getBoundingClientRect();
        const next: Layout = {
            items,
            tops,
            total: scroll.scrollHeight,
            gutter: laneBox.right - inner.getBoundingClientRect().right,
            railTop: scrollBox.top - laneBox.top + RAIL_INSET,
            railHeight: Math.max(0, scrollBox.height - RAIL_INSET - RAIL_BOTTOM_CLEARANCE),
        };
        setLayout((prev) => (
            prev.total === next.total && prev.gutter === next.gutter && prev.railTop === next.railTop
            && prev.railHeight === next.railHeight && prev.items.length === next.items.length
            && prev.items.every((item, i) => item === next.items[i]) && prev.tops.every((top, i) => top === next.tops[i])
        ) ? prev : next);
        setView({ scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight });
    }, [allItems, scrollRef, innerRef]);

    useLayoutEffect(() => { measure(); }, [measure]);

    useEffect(() => {
        const scroll = scrollRef.current;
        const inner = innerRef.current;
        if (!scroll || !inner) return;
        let raf = 0;
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; measure(); });
        };
        const onScroll = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                setView({ scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight });
            });
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
        observer?.observe(inner);
        observer?.observe(scroll);
        if (scroll.parentElement) observer?.observe(scroll.parentElement);
        scroll.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            observer?.disconnect();
            scroll.removeEventListener('scroll', onScroll);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [measure, scrollRef, innerRef]);

    const { items, tops } = layout;
    const active = activeRailIndex(tops, view);
    const showRail = shouldShowRail({ finePointer: fine, gutter: layout.gutter, count: items.length });

    const scrollToIndex = (index: number) => {
        const scroll = scrollRef.current;
        const top = tops[index];
        if (!scroll || top === undefined) return;
        scroll.scrollTo({ top: railScrollTarget(top), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    };

    if (showRail) {
        const tabIndex = focusIndex ?? (active >= 0 ? active : 0);
        const trackTop = hasMoreOlder ? OLDER_SLOT : 0;
        const trackHeight = Math.max(0, layout.railHeight - trackTop);
        const tickY = (index: number) => trackTop + (railTickPercent(tops[index], layout.total) / 100) * trackHeight;
        const previewItem = preview !== null ? items[preview] : null;
        const focusTick = (index: number) => {
            setFocusIndex(index);
            setPreview(index);
            requestAnimationFrame(() => railRef.current?.querySelectorAll<HTMLButtonElement>('.cl-rail-tick')[index]?.focus());
        };
        return (
            <div
                ref={railRef}
                className="cl-rail"
                role="toolbar"
                aria-orientation="vertical"
                aria-label={copy.railLabel}
                style={{ top: layout.railTop, height: layout.railHeight }}
                onPointerLeave={() => { if (!railRef.current?.contains(document.activeElement)) setPreview(null); }}
                onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setPreview(null);
                        setFocusIndex(null);
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') { setPreview(null); return; }
                    const next = railKeyStep(event.key, focusIndex ?? tabIndex, items.length);
                    if (next === null) return;
                    event.preventDefault();
                    focusTick(next);
                    scrollToIndex(next);
                }}
                // The rail overlays the lane outside the scroller: forward the wheel
                // so reading never freezes under the pointer.
                onWheel={(event) => {
                    const scroll = scrollRef.current;
                    if (!scroll || event.ctrlKey) return;
                    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1;
                    scroll.scrollTop += event.deltaY * scale;
                }}
            >
                {hasMoreOlder && (
                    <button
                        type="button"
                        className="cl-rail-older"
                        tabIndex={-1}
                        aria-label={copy.railOlderAction}
                        title={copy.railOlderAction}
                        disabled={isLoadingOlder}
                        onClick={() => void sync.loadOlderMessages(sessionId)}
                    >
                        <ChevronsUp size={12} aria-hidden />
                    </button>
                )}
                {items.map((item, index) => (
                    <button
                        key={item.id}
                        type="button"
                        className={`cl-rail-tick${index === active ? ' is-active' : ''}${index === preview ? ' is-preview' : ''}`}
                        style={{ top: tickY(index) }}
                        tabIndex={index === tabIndex ? 0 : -1}
                        aria-label={item.text || copy.railAttachment}
                        aria-current={index === active ? 'true' : undefined}
                        onPointerEnter={(event) => { if (event.pointerType !== 'touch') setPreview(index); }}
                        onFocus={(event) => {
                            setFocusIndex(index);
                            if (event.currentTarget.matches(':focus-visible')) setPreview(index);
                        }}
                        onClick={() => { setPreview(null); scrollToIndex(index); }}
                    >
                        <span className="cl-rail-mark" aria-hidden />
                    </button>
                ))}
                {previewItem && preview !== null && (
                    <div
                        className="cl-rail-preview"
                        aria-hidden
                        style={{ top: Math.min(Math.max(0, tickY(preview) - 14), Math.max(0, layout.railHeight - 72)) }}
                    >
                        <p className="cl-rail-preview-text">{previewItem.text || copy.railAttachment}</p>
                        <p className="cl-rail-preview-reply">{previewItem.reply || copy.railNoReply}</p>
                    </div>
                )}
            </div>
        );
    }

    if (!navVisible || items.length === 0) return null;
    const prev = adjacentPromptIndex(tops, view.scrollTop, -1);
    const next = isAtBottom(view) ? null : adjacentPromptIndex(tops, view.scrollTop, 1);
    return (
        <div className="cl-promptnav" role="group" aria-label={copy.railLabel}>
            <button
                type="button"
                className="cl-promptnav-btn"
                aria-label={copy.prevPrompt}
                title={copy.prevPrompt}
                disabled={prev === null}
                onClick={() => { if (prev !== null) scrollToIndex(prev); }}
            >
                <ChevronUp size={18} aria-hidden />
            </button>
            <button
                type="button"
                className="cl-promptnav-btn"
                aria-label={copy.nextPrompt}
                title={copy.nextPrompt}
                disabled={next === null}
                onClick={() => { if (next !== null) scrollToIndex(next); }}
            >
                <ChevronDown size={18} aria-hidden />
            </button>
        </div>
    );
}
