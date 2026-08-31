/**
 * Web「回前台」边沿检测 —— 纯函数（spec `specs/2026-08-web-resume-sync.md` §A）。
 *
 * 为什么不看 `document.hasFocus()`：那是推送抑制的「active」语义（visible 且有焦点）。
 * iOS Safari/PWA 从后台回来时 `hasFocus()` 常保持 false、window `focus` 也不一定触发，
 * 把重同步绑在它上面就是「回前台不刷新」的直接原因之一。这里只认可见性边沿：
 *  - `visibilitychange` hidden → visible；
 *  - `pageshow` 且 `persisted === true`（bfcache 恢复没有 hidden 边沿）；
 *  - `online`（hidden 时也会发，必须以 visible 门控）；
 *  - Chromium Page Lifecycle `resume`（Safari 无此事件，只是额外边沿）。
 * 多个事件常同时到达（visible + pageshow + focus），1s 内合并为一次。
 * 首次加载没有边沿，不触发（初始 fetch 走既有路径）。
 */

export const RESUME_DEBOUNCE_MS = 1_000;

export type ResumeEvent =
    | { type: 'visibilitychange'; visible: boolean }
    | { type: 'pageshow'; persisted: boolean; visible: boolean }
    | { type: 'online'; visible: boolean }
    | { type: 'resume'; visible: boolean };

export type ResumeState = {
    /** 上一次观察到的可见性；用于判 hidden → visible 边沿。 */
    visible: boolean;
    /** 上一次发出 resume 的时刻（去抖基准）。 */
    lastResumeAt: number | null;
};

export function initialResumeState(visible: boolean): ResumeState {
    return { visible, lastResumeAt: null };
}

export function decideResume(
    state: ResumeState,
    event: ResumeEvent,
    now: number,
): { state: ResumeState; resume: boolean } {
    let edge = false;
    switch (event.type) {
        case 'visibilitychange':
            edge = event.visible && !state.visible;
            break;
        case 'pageshow':
            edge = event.persisted && event.visible;
            break;
        case 'online':
        case 'resume':
            edge = event.visible;
            break;
    }
    const next: ResumeState = { ...state, visible: event.visible };
    if (!edge) return { state: next, resume: false };
    if (state.lastResumeAt !== null && now - state.lastResumeAt < RESUME_DEBOUNCE_MS) {
        return { state: next, resume: false };
    }
    return { state: { ...next, lastResumeAt: now }, resume: true };
}

type ResumeTargets = {
    doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
    win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
};

/**
 * DOM 接线（唯一入口）。返回解绑函数。`now` 可注入便于测试。
 */
export function attachResumeListeners(
    targets: ResumeTargets,
    onResume: () => void,
    now: () => number = () => Date.now(),
): () => void {
    const { doc, win } = targets;
    const isVisible = () => doc.visibilityState === 'visible';
    let state = initialResumeState(isVisible());
    const feed = (event: ResumeEvent) => {
        const result = decideResume(state, event, now());
        state = result.state;
        if (result.resume) onResume();
    };
    const onVisibility = () => feed({ type: 'visibilitychange', visible: isVisible() });
    const onPageShow = (e: Event) => feed({
        type: 'pageshow',
        persisted: (e as PageTransitionEvent).persisted === true,
        visible: isVisible(),
    });
    const onOnline = () => feed({ type: 'online', visible: isVisible() });
    const onLifecycleResume = () => feed({ type: 'resume', visible: isVisible() });
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pageshow', onPageShow);
    win.addEventListener('online', onOnline);
    doc.addEventListener('resume', onLifecycleResume);
    return () => {
        doc.removeEventListener('visibilitychange', onVisibility);
        win.removeEventListener('pageshow', onPageShow);
        win.removeEventListener('online', onOnline);
        doc.removeEventListener('resume', onLifecycleResume);
    };
}
