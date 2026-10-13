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
import {
    activeRailIndex,
    adjacentPromptIndex,
    isAtBottom,
    railItemsFromRows,
    railKeyStep,
    quantizeRailPercents,
    railScrollTarget,
    sameNumbers,
    shouldShowRail,
    type RailItem,
} from './chatRail';

type Layout = {
    /** 有 DOM 的条目。 */
    items: RailItem[];
    /** 各条目的刻度位置（量化后的百分比）。 */
    pcts: number[];
    gutter: number;
    /** 轨道在 `.cl` 内的上沿与高度（覆盖 transcript 可视区，不压排队 dock）。 */
    railTop: number;
    railHeight: number;
};

/** 滚动位置推出来的状态：只在变化时重渲染，滚动本身不触发渲染。 */
type Nav = { active: number; prev: number | null; next: number | null };

const EMPTY: Layout = { items: [], pcts: [], gutter: 0, railTop: 0, railHeight: 0 };
const NO_NAV: Nav = { active: -1, prev: null, next: null };
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
    const { t } = useTranslation();
    const fine = useFinePointer();
    // rows are rebuilt on every streamed chunk; keep the item list (and with it
    // the measuring layout effect) stable unless a prompt or its preview changed.
    const itemsRef = useRef<RailItem[]>([]);
    const allItems = useMemo(() => {
        const next = railItemsFromRows(rows);
        const prev = itemsRef.current;
        const same = prev.length === next.length
            && prev.every((item, i) => item.id === next[i].id && item.text === next[i].text && item.reply === next[i].reply);
        if (!same) itemsRef.current = next;
        return itemsRef.current;
    }, [rows]);
    const [layout, setLayout] = useState<Layout>(EMPTY);
    const [nav, setNav] = useState<Nav>(NO_NAV);
    const [preview, setPreview] = useState<number | null>(null);
    const [focusIndex, setFocusIndex] = useState<number | null>(null);
    const railRef = useRef<HTMLDivElement>(null);
    /** 原始 offsetTop（滚动目标与当前项用），不进 state。 */
    const topsRef = useRef<number[]>([]);
    const navVisibleRef = useRef(navVisible);
    navVisibleRef.current = navVisible;

    const updateNav = useCallback(() => {
        const scroll = scrollRef.current;
        if (!scroll) return;
        const tops = topsRef.current;
        const view = { scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight };
        const next: Nav = {
            active: activeRailIndex(tops, view),
            prev: adjacentPromptIndex(tops, view.scrollTop, -1),
            next: isAtBottom(view) ? null : adjacentPromptIndex(tops, view.scrollTop, 1),
        };
        setNav((prev) => (prev.active === next.active && prev.prev === next.prev && prev.next === next.next ? prev : next));
    }, [scrollRef]);

    const measure = useCallback(() => {
        const scroll = scrollRef.current;
        const inner = innerRef.current;
        const lane = scroll?.parentElement;
        if (!scroll || !inner || !lane) return;
        const scrollBox = scroll.getBoundingClientRect();
        const laneBox = lane.getBoundingClientRect();
        const gutter = Math.round(laneBox.right - inner.getBoundingClientRect().right);
        const railTop = Math.round(scrollBox.top - laneBox.top + RAIL_INSET);
        const railHeight = Math.round(Math.max(0, scrollBox.height - RAIL_INSET - RAIL_BOTTOM_CLEARANCE));
        // Neither the rail nor the buttons can show: skip the per-prompt reads.
        const wanted = shouldShowRail({ finePointer: fine, gutter, count: allItems.length }) || navVisibleRef.current;
        const items: RailItem[] = [];
        const tops: number[] = [];
        if (wanted) {
            const byId = new Map<string, Element>();
            for (const el of inner.querySelectorAll('[data-chat-prompt-id]')) {
                const id = el.getAttribute('data-chat-prompt-id');
                if (id) byId.set(id, el);
            }
            for (const item of allItems) {
                const el = byId.get(item.id);
                if (!el) continue;
                items.push(item);
                tops.push(el.getBoundingClientRect().top - scrollBox.top + scroll.scrollTop);
            }
        }
        topsRef.current = tops;
        const pcts = quantizeRailPercents(tops, scroll.scrollHeight);
        setLayout((prev) => (
            prev.gutter === gutter && prev.railTop === railTop && prev.railHeight === railHeight
            && prev.items.length === items.length && prev.items.every((item, i) => item === items[i])
            && sameNumbers(prev.pcts, pcts)
        ) ? prev : { items, pcts, gutter, railTop, railHeight });
        updateNav();
    }, [allItems, fine, scrollRef, innerRef, updateNav]);

    useLayoutEffect(() => { measure(); }, [measure, navVisible]);

    useEffect(() => {
        const scroll = scrollRef.current;
        const inner = innerRef.current;
        if (!scroll || !inner) return;
        // Separate frames: a pending scroll update must not swallow a resize.
        let measureFrame = 0;
        let scrollFrame = 0;
        const schedule = () => {
            if (measureFrame) return;
            measureFrame = requestAnimationFrame(() => { measureFrame = 0; measure(); });
        };
        const onScroll = () => {
            if (scrollFrame) return;
            scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateNav(); });
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
        observer?.observe(inner);
        observer?.observe(scroll);
        if (scroll.parentElement) observer?.observe(scroll.parentElement);
        scroll.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            observer?.disconnect();
            scroll.removeEventListener('scroll', onScroll);
            if (measureFrame) cancelAnimationFrame(measureFrame);
            if (scrollFrame) cancelAnimationFrame(scrollFrame);
        };
    }, [measure, updateNav, scrollRef, innerRef]);

    const { items, pcts } = layout;
    const active = nav.active;
    const showRail = shouldShowRail({ finePointer: fine, gutter: layout.gutter, count: items.length });

    const scrollToIndex = (index: number) => {
        const scroll = scrollRef.current;
        const top = topsRef.current[index];
        if (!scroll || top === undefined) return;
        scroll.scrollTo({ top: railScrollTarget(top), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    };

    if (showRail) {
        const tabIndex = focusIndex ?? (active >= 0 ? active : 0);
        const trackTop = hasMoreOlder ? OLDER_SLOT : 0;
        const trackHeight = Math.max(0, layout.railHeight - trackTop);
        const tickY = (index: number) => Math.round(trackTop + ((pcts[index] ?? 0) / 100) * trackHeight);
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
                aria-label={t('session.chat.readingAids.railLabel')}
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
                        aria-label={t('session.chat.readingAids.railOlderAction')}
                        title={t('session.chat.readingAids.railOlderAction')}
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
                        aria-label={item.text || t('session.chat.readingAids.railAttachment')}
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
                        <p className="cl-rail-preview-text">{previewItem.text || t('session.chat.readingAids.railAttachment')}</p>
                        <p className="cl-rail-preview-reply">{previewItem.reply || t('session.chat.readingAids.railNoReply')}</p>
                    </div>
                )}
            </div>
        );
    }

    if (!navVisible || items.length === 0) return null;
    const { prev, next } = nav;
    return (
        <div className="cl-promptnav" role="group" aria-label={t('session.chat.readingAids.railLabel')}>
            <button
                type="button"
                className="cl-promptnav-btn"
                aria-label={t('session.chat.readingAids.prevPrompt')}
                title={t('session.chat.readingAids.prevPrompt')}
                disabled={prev === null}
                onClick={() => { if (prev !== null) scrollToIndex(prev); }}
            >
                <ChevronUp size={18} aria-hidden />
            </button>
            <button
                type="button"
                className="cl-promptnav-btn"
                aria-label={t('session.chat.readingAids.nextPrompt')}
                title={t('session.chat.readingAids.nextPrompt')}
                disabled={next === null}
                onClick={() => { if (next !== null) scrollToIndex(next); }}
            >
                <ChevronDown size={18} aria-hidden />
            </button>
        </div>
    );
}
