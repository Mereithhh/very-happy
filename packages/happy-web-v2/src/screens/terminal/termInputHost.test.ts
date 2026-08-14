/**
 * termInputHost 的纯判定 + 接线层的**结构约束**。
 *
 * 测试环境是 node（无 jsdom），所以这里测两类东西：
 *  1. 从宿主里抽出来的纯函数（观测时机、宽度策略、焦点补发判定、开关解析）；
 *  2. 对源码本身的结构断言 —— spec §可测试性 / §验收标准 里那几条"只能靠 grep
 *     钉住"的不变量（不许 window capture、只补发 keydown、不许用 disableStdin、
 *     `.vh-term-input` 恒 ≤1 个、元素必须挂在 `term.element` 内部）。
 *     这些不是形式主义：历史上每一次输入路径事故的复发，都是某个"约定"没有任何
 *     机械手段兜住。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    COMPOSITION_STALE_MS,
    OVERLAY_MAX_CELLS,
    OVERLAY_MAX_CELLS_COARSE,
    IOS_ZOOM_SAFE_FONT_PX,
    shouldObserveField,
    isCompositionStale,
    initialStaleTally,
    tallyCompositionStale,
    resetStaleWindow,
    pickOverlayWidth,
    pickOverlayMetrics,
    pickFieldPolicy,
    vtKeyClearsField,
    shouldShowPreedit,
    mirrorFocusAction,
    resolveInputOwnership,
} from './termInputHost';
import { routeKey, type KeyEventLike } from './termInputRoute';
import { reduce, initialState, type TermInputState } from './termInputModel';

describe('shouldObserveField —— ★ 宿主观测时机的三条真实边界', () => {
    it('① 非合成 input 观测；合成中的 input 不观测', () => {
        expect(shouldObserveField({ kind: 'input', isComposing: false })).toBe(true);
        expect(shouldObserveField({ kind: 'input', isComposing: true })).toBe(false);
    });

    it('② compositionend 观测', () => {
        expect(shouldObserveField({ kind: 'composition-end' })).toBe(true);
    });

    it('③ blur 观测（在途内容恰好提交一次）', () => {
        expect(shouldObserveField({ kind: 'blur' })).toBe(true);
    });

    it('没有第四条：触发器里不存在任何带时钟的 kind（时钟猜不出合成状态）', () => {
        // 原第 4 条兜底"停滞 5s 就无条件观测"是一条**实证过的泄漏**（拉丁 preedit
        // 被当正文灌进 PTY）。这里钉的是**类型层面**的不可表达：`ObserveTrigger`
        // 的 kind 集合只有三个，且没有一个带 now/lastCompositionAt。
        const kinds = ['input', 'composition-end', 'blur'] as const;
        for (const kind of kinds) {
            const t = kind === 'input'
                ? { kind, isComposing: false } as const
                : { kind } as const;
            expect(typeof shouldObserveField(t)).toBe('boolean');
        }
        // @ts-expect-error tick 不再是合法触发器 —— **编译期这行报错本身就是断言**
        // （去掉 @ts-expect-error 或把 tick 加回联合类型，tsc 门禁立刻红）。
        const bogus = shouldObserveField({ kind: 'tick', now: 1, lastCompositionAt: 0 });
        // 运行时也落不到任何分支（switch 无 default）⇒ 观测不会被触发。
        expect(bogus).toBeUndefined();
    });
});

describe('合成停滞：只记数不动作（原兜底 tick 的替代物）', () => {
    const IN = (composing: boolean, now: number, lastCompositionAt: number) =>
        ({ composing, now, lastCompositionAt });

    it('合成中且停滞超过阈值 ⇒ 判定为 stale（严格大于）', () => {
        const t0 = 1_000_000;
        expect(isCompositionStale(IN(true, t0 + COMPOSITION_STALE_MS, t0))).toBe(false);
        expect(isCompositionStale(IN(true, t0 + COMPOSITION_STALE_MS + 1, t0))).toBe(true);
    });

    it('非合成期恒 false —— 桌面稳态（lastCompositionAt=0）不许被记成病态', () => {
        expect(isCompositionStale(IN(false, Date.now(), 0))).toBe(false);
        expect(isCompositionStale(IN(false, Date.now(), 1))).toBe(false);
        // 合成中但从未收到过 composition 事件（不可能的组合）也不记。
        expect(isCompositionStale(IN(true, Date.now(), 0))).toBe(false);
    });

    it('活跃合成不断续命 ⇒ 永不判 stale', () => {
        const t0 = 1_000_000;
        const end = t0 + 60_000;
        let last = t0;
        for (let t = t0; t < end; t += 300) {
            last = t; // 一次 compositionupdate
            expect(isCompositionStale(IN(true, t + 250, last))).toBe(false);
        }
    });

    it('计数器：一个停滞窗口只记一次（250ms 一 tick，不许刷成几十条）', () => {
        const t0 = 1_000_000;
        let tally = initialStaleTally();
        expect(tally.seen).toBe(0);
        for (let i = 0; i < 40; i++) {
            tally = tallyCompositionStale(tally, IN(true, t0 + COMPOSITION_STALE_MS + 1 + i * 250, t0));
        }
        expect(tally.seen).toBe(1);
    });

    it('计数器：IME 又活了之后再停一次 ⇒ 记第二次（如实反映两段停滞）', () => {
        const t0 = 1_000_000;
        let tally = tallyCompositionStale(initialStaleTally(), IN(true, t0 + 6000, t0));
        expect(tally.seen).toBe(1);
        // 一个 compositionupdate 到达 ⇒ 窗口重开。
        tally = resetStaleWindow(tally);
        const t1 = t0 + 10_000;
        tally = tallyCompositionStale(tally, IN(true, t1 + 6000, t1));
        expect(tally.seen).toBe(2);
    });

    it('计数器只增不减，且**永不**产生动作/字节（返回值里只有数字与布尔）', () => {
        const t0 = 1_000_000;
        const out = tallyCompositionStale(initialStaleTally(), IN(true, t0 + 6000, t0));
        expect(Object.keys(out).sort()).toEqual(['noted', 'seen']);
        // 正常路径下调它一万次也不动。
        let tally = initialStaleTally();
        for (let t = 0; t < 100_000; t += 250) tally = tallyCompositionStale(tally, IN(false, t, 0));
        expect(tally.seen).toBe(0);
    });
});

describe('pickOverlayWidth —— spec §B 的宽度策略 min(40ch, 到右边缘)', () => {
    const CELL = 8;
    const SCREEN = 800; // 100 列

    it('行首：取 40 列上限', () => {
        expect(pickOverlayWidth({ cursorLeft: 0, screenWidth: SCREEN, cellWidth: CELL }))
            .toBe(OVERLAY_MAX_CELLS * CELL);
    });

    it('靠近右边缘：收到边缘，不溢出（否则会触发换行/水平滚动，候选窗跟着跑偏）', () => {
        expect(pickOverlayWidth({ cursorLeft: 600, screenWidth: SCREEN, cellWidth: CELL })).toBe(200);
    });

    it('恰好 40 列处的分界', () => {
        const left = SCREEN - OVERLAY_MAX_CELLS * CELL;
        expect(pickOverlayWidth({ cursorLeft: left, screenWidth: SCREEN, cellWidth: CELL }))
            .toBe(OVERLAY_MAX_CELLS * CELL);
        expect(pickOverlayWidth({ cursorLeft: left + CELL, screenWidth: SCREEN, cellWidth: CELL }))
            .toBe(OVERLAY_MAX_CELLS * CELL - CELL);
    });

    it('光标贴死右边缘/越界：至少留一个单元格（宽度 0 的输入域收不到 IME）', () => {
        expect(pickOverlayWidth({ cursorLeft: SCREEN, screenWidth: SCREEN, cellWidth: CELL })).toBe(CELL);
        expect(pickOverlayWidth({ cursorLeft: SCREEN + 40, screenWidth: SCREEN, cellWidth: CELL })).toBe(CELL);
    });

    it('尚未测出字号（cellWidth 0）时不返回负数', () => {
        expect(pickOverlayWidth({ cursorLeft: 0, screenWidth: 0, cellWidth: 0 })).toBe(0);
    });

    it('maxCells 可配（移动端窄屏留的口子）', () => {
        expect(pickOverlayWidth({ cursorLeft: 0, screenWidth: SCREEN, cellWidth: CELL, maxCells: 10 }))
            .toBe(80);
    });
});

describe('mirrorFocusAction —— 焦点补发（DEC 1004 / 光标观感）', () => {
    it('两边一致 ⇒ 不补发（保证不重复上报 ESC[I / ESC[O）', () => {
        expect(mirrorFocusAction(false, false)).toBe('none');
        expect(mirrorFocusAction(true, true)).toBe('none');
    });

    it('我们拿到焦点而 xterm 不知道 ⇒ 补发 focus', () => {
        expect(mirrorFocusAction(false, true)).toBe('focus');
    });

    it('我们失去焦点而 xterm 仍以为在 ⇒ 补发 blur', () => {
        expect(mirrorFocusAction(true, false)).toBe('blur');
    });

    it('自愈：xterm 内部抢焦点又被弹回来之后，一次求值就把两边对齐', () => {
        // 现场：点击终端 → xterm 自己 focus 了 helper textarea（.focus class 加上）
        // → 我们把焦点弹回 → 原生 blur 把 class 摘掉 → 此刻 (false, true)。
        expect(mirrorFocusAction(false, true)).toBe('focus');
        // 补发之后再求值：一致，不再动作（幂等）。
        expect(mirrorFocusAction(true, true)).toBe('none');
    });
});

describe('resolveInputOwnership —— 设置 ⊕ URL 覆盖（Step 2 起与设备无关）', () => {
    it('默认（无设置无参数）= 旧路径', () => {
        expect(resolveInputOwnership({ setting: undefined, urlParam: null })).toBe('xterm');
    });

    it('设置生效', () => {
        expect(resolveInputOwnership({ setting: 'own', urlParam: null })).toBe('own');
        expect(resolveInputOwnership({ setting: 'xterm', urlParam: null })).toBe('xterm');
    });

    it('?input= 覆盖设置（两个方向都要能覆盖 —— golden 差分要在同一构建上跑两轮）', () => {
        expect(resolveInputOwnership({ setting: 'xterm', urlParam: 'own' })).toBe('own');
        expect(resolveInputOwnership({ setting: 'own', urlParam: 'xterm' })).toBe('xterm');
    });

    it('无法识别的 ?input= 值被忽略，回落到设置', () => {
        expect(resolveInputOwnership({ setting: 'own', urlParam: 'yes' })).toBe('own');
        expect(resolveInputOwnership({ setting: 'own', urlParam: '' })).toBe('own');
    });

    it('Step 2：判断里不再有设备维度 —— 互斥只由这一个值保证', () => {
        // Step 1 的设备门（粗指针强制 'xterm'）已经删掉：移动端 Step 2 接同一条
        // 路径，`own` ⇒ 不装 mobileInputBridge（结构测试兜住那一半）。
        expect(resolveInputOwnership({ setting: 'own', urlParam: null })).toBe('own');
        expect(resolveInputOwnership({ setting: 'own', urlParam: 'own' })).toBe('own');
    });
});

describe('pickFieldPolicy —— 两端唯一的分叉（spec §E/§F）', () => {
    it('粗指针 = sticky：绝不主动清空输入域（"删不掉的最后一个字母"）', () => {
        expect(pickFieldPolicy(true)).toBe('sticky');
    });

    it('桌面 = clear-on-idle：硬件键盘不镜像字段内容，残字必须回收', () => {
        expect(pickFieldPolicy(false)).toBe('clear-on-idle');
    });

    it('sticky 策略下模型确实不会因为 idle 而清空（回归锚）', () => {
        let s = initialState(pickFieldPolicy(true));
        s = reduce(s, { type: 'field-value', value: 'abc', at: 0 }).state;
        const r = reduce(s, { type: 'tick', now: 999_999 });
        expect(r.clearField).toBe(false);
        expect(r.state.shadow).toBe('abc');
        // 桌面同样的序列则清空。
        let d = initialState(pickFieldPolicy(false));
        d = reduce(d, { type: 'field-value', value: 'abc', at: 0 }).state;
        expect(reduce(d, { type: 'tick', now: 999_999 }).clearField).toBe(true);
    });
});

describe('pickOverlayMetrics —— 粗指针的几何分叉（spec §风险 R5）', () => {
    const base = { cellFontSize: 12, cellHeight: 16, cursorLeft: 0, screenWidth: 800, cellWidth: 8 };

    it('桌面：逐字段照抄光标单元格，宽度上限 40 列', () => {
        const m = pickOverlayMetrics({ ...base, coarsePointer: false });
        expect(m.fontSize).toBe(12);
        expect(m.height).toBe(16);
        expect(m.width).toBe(OVERLAY_MAX_CELLS * 8);
    });

    it('粗指针：字号抬到 16px —— iOS 聚焦 <16px 字段会放大整页，而放大后 vv.scale>1，'
        + '软键盘避让数学（onViewport）会整个停摆', () => {
        const m = pickOverlayMetrics({ ...base, coarsePointer: true });
        expect(m.fontSize).toBe(IOS_ZOOM_SAFE_FONT_PX);
        expect(m.fontSize).toBeGreaterThanOrEqual(16);
    });

    it('粗指针：盒高跟着字号抬 —— 否则 preedit 被 overflow:hidden 削掉一半', () => {
        const m = pickOverlayMetrics({ ...base, coarsePointer: true });
        expect(m.height).toBeGreaterThanOrEqual(16);
        expect(m.height).toBeGreaterThanOrEqual(m.fontSize);
    });

    it('粗指针：宽度上限收到 24 列（窄屏上 40 列就是整行，给 iOS pan 更多借口）', () => {
        const m = pickOverlayMetrics({ ...base, coarsePointer: true });
        expect(m.width).toBe(OVERLAY_MAX_CELLS_COARSE * 8);
        expect(m.width).toBeLessThan(OVERLAY_MAX_CELLS * 8);
    });

    it('两端都收在右边缘内 —— 元素不许伸出终端屏幕（否则触发水平 pan/滚动）', () => {
        for (const coarsePointer of [false, true]) {
            const m = pickOverlayMetrics({ ...base, coarsePointer, cursorLeft: 780 });
            expect(m.width).toBeLessThanOrEqual(base.screenWidth - 780);
        }
    });

    it('终端字号本来就 ≥16 时不再抬高（桌面大字号 / 平板）', () => {
        const m = pickOverlayMetrics({ ...base, coarsePointer: true, cellFontSize: 20, cellHeight: 26 });
        expect(m.fontSize).toBe(20);
        expect(m.height).toBe(26);
    });

    it('首帧尚未测出单元格（全 0）时不返回负数/NaN', () => {
        const m = pickOverlayMetrics({
            coarsePointer: true, cellFontSize: 0, cellHeight: 0,
            cursorLeft: 0, screenWidth: 0, cellWidth: 0,
        });
        expect(m.width).toBe(0);
        expect(Number.isFinite(m.height)).toBe(true);
        expect(m.height).toBeGreaterThan(0);
    });
});

describe('vtKeyClearsField —— 行边界清空，照抄 xterm 自己的 CR/ETX 规则', () => {
    const k = (o: Partial<Parameters<typeof vtKeyClearsField>[0]>) =>
        ({ key: 'a', ctrlKey: false, altKey: false, metaKey: false, ...o });

    it('Enter（→ CR）清空', () => {
        expect(vtKeyClearsField(k({ key: 'Enter' }))).toBe(true);
    });

    it('Ctrl+C（→ ETX）清空，大小写都算', () => {
        expect(vtKeyClearsField(k({ key: 'c', ctrlKey: true }))).toBe(true);
        expect(vtKeyClearsField(k({ key: 'C', ctrlKey: true }))).toBe(true);
    });

    it('其余 VT 键一律不清 —— 退格/方向键清了会把当前行凭空丢掉', () => {
        expect(vtKeyClearsField(k({ key: 'Backspace' }))).toBe(false);
        expect(vtKeyClearsField(k({ key: 'ArrowLeft' }))).toBe(false);
        expect(vtKeyClearsField(k({ key: 'Tab' }))).toBe(false);
        expect(vtKeyClearsField(k({ key: 'd', ctrlKey: true }))).toBe(false);
    });

    it('带 Alt/Meta 的组合不清（编码结果不是 CR/ETX）', () => {
        expect(vtKeyClearsField(k({ key: 'Enter', altKey: true }))).toBe(false);
        expect(vtKeyClearsField(k({ key: 'Enter', metaKey: true }))).toBe(false);
        expect(vtKeyClearsField(k({ key: 'c', ctrlKey: true, altKey: true }))).toBe(false);
    });

    it('合成期的清空由模型自己拒绝（宿主不需要第二道判断）', () => {
        const s = reduce(initialState('sticky'), { type: 'composition-start' }).state;
        expect(reduce(s, { type: 'clear-request' }).clearField).toBe(false);
    });
});

describe('shouldShowPreedit —— 合成气泡（纯装饰，粗指针专用）', () => {
    it('合成中且聚焦才露出', () => {
        expect(shouldShowPreedit({ composing: true, focused: true })).toBe(true);
    });

    it('失焦即摘 —— 自过期，不可能留一个亮框在屏上', () => {
        expect(shouldShowPreedit({ composing: true, focused: false })).toBe(false);
    });

    it('静止不露（sticky 下字段里留着当前行，常显就会和 PTY 回显叠字）', () => {
        expect(shouldShowPreedit({ composing: false, focused: true })).toBe(false);
        expect(shouldShowPreedit({ composing: false, focused: false })).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════
// 「一行文本恰好进 PTY 一次」—— barMode 双发问题的结论钉子（Step 2）
// ════════════════════════════════════════════════════════════════════════

/**
 * 宿主接线的**模型级重放**：node 环境没有 jsdom，装不起真 DOM，但宿主的
 * "keydown → routeKey → (VT | 输入域) → reduce" 这条链是可以逐句复刻的。
 * 这里复刻的是 `installTermInput` 里 `onKeyDown` / `onInput` / `sendLine` 的
 * 真实顺序，用的是**同一批真模块**（`routeKey` / `reduce` / `shouldObserveField`
 * / `vtKeyClearsField`），只把 DOM 换成一个字符串字段、把 xterm 的编码器换成
 * 一张两个键的小表。
 */
const VT_BYTES: Record<string, string> = { Enter: '\r', Backspace: '\x7f' };

function makeSurface(opts: { policy: 'sticky' | 'clear-on-idle'; barMode: boolean }) {
    let field = '';
    let state: TermInputState = initialState(opts.policy);
    let clock = 0;
    const pty: string[] = [];
    const send = (d: string) => { if (d) pty.push(d); };

    const apply = (ev: Parameters<typeof reduce>[1]) => {
        const r = reduce(state, ev);
        state = r.state;
        if (r.emit) send(r.emit);
        if (r.clearField) {
            field = '';
            state = reduce(state, { type: 'adopt', value: field }).state;
        }
    };
    const observe = () => apply({ type: 'field-value', value: field, at: ++clock });

    const key = (k: string, mods: Partial<KeyEventLike> = {}) => {
        const ev: KeyEventLike = {
            key: k, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
        };
        const d = routeKey(ev, {
            isMac: true,
            barMode: opts.barMode,
            modes: { applicationCursorKeysMode: false, applicationKeypadMode: false },
        });
        if (d.kind === 'vt') {
            send(VT_BYTES[k] ?? '');
            if (vtKeyClearsField(ev)) apply({ type: 'clear-request' });
            return;
        }
        if (d.kind === 'send-line') {
            // 宿主的 sendLine：先补观测（把还没观测到的字段内容送出去），再补 CR。
            observe();
            apply({ type: 'clear-request' });
            send('\r');
            return;
        }
        if (d.kind === 'text' || d.kind === 'ime') {
            // 浏览器把字符插进输入域 → `input` 事件（非合成）→ 观测。
            field += k;
            if (shouldObserveField({ kind: 'input', isComposing: false })) observe();
        }
    };

    // ── 合成（IME）：复刻宿主的 compositionstart/update/end + blur 接线 ────────
    // 浏览器在合成期把 preedit 写进输入域并发 `input`（`isComposing:true`），
    // 宿主据 ① 不观测；真正的提交靠 ②/③ 或 IME 中止后的非合成 `input`。
    const compositionStart = () => apply({ type: 'composition-start' });
    /** 合成中的一次 preedit 变化（拉丁拼音进字段，但一个字节都不该进 PTY）。 */
    const preedit = (value: string) => {
        field = value;
        if (shouldObserveField({ kind: 'input', isComposing: true })) observe();
    };
    /** 正常提交：字段换成汉字，compositionend 到达（宿主随后 observe）。 */
    const compositionEnd = (committed: string) => {
        field = committed;
        apply({ type: 'composition-end' });
        if (shouldObserveField({ kind: 'composition-end' })) observe();
    };
    /** IME 中止/切走：浏览器给的下一个 `input` 的 isComposing 就是 false。 */
    const plainInput = (value: string) => {
        field = value;
        if (shouldObserveField({ kind: 'input', isComposing: false })) observe();
    };
    /** 失焦：宿主先解 composing 再观测。 */
    const blur = () => {
        apply({ type: 'blur' });
        if (shouldObserveField({ kind: 'blur' })) observe();
    };

    return {
        type: (s: string) => { for (const ch of s) key(ch); },
        key,
        tick: (now: number) => apply({ type: 'tick', now }),
        compositionStart,
        preedit,
        compositionEnd,
        plainInput,
        blur,
        get composing() { return state.composing; },
        get pty() { return pty.join(''); },
        get chunks() { return pty.slice(); },
        get field() { return field; },
    };
}

describe('一行文本恰好进 PTY 一次（barMode 双发问题的结论）', () => {
    /**
     * 结论：**barMode 下不停用增量观测**，而且移动端接线里 overlay 的 barMode
     * 恒 false（见 `WebTerminalScreen` 那段注释与下面的结构断言）。
     *
     * 依据：输入行模式的输入面是 `TermInputBar` 自己的 `<textarea>`，它在
     * `term.element` **之外**，宿主的监听器一个都碰不到 —— 双发在结构上不可能。
     * 反过来，如果 barMode 下停用增量观测，overlay 一旦拿到焦点（xterm 的
     * mousedown 会抢焦点，宿主再弹回来）就变成一个**静默缓冲区**：用户打字看不到
     * 任何回显，直到 Enter 或失焦才一次性倾泻 —— 那正是本 spec 要消灭的吞字形态。
     */
    it('逐键模式（生产接线，barMode=false）：整行 + 一个 CR，一次不多一次不少', () => {
        const s = makeSurface({ policy: 'sticky', barMode: false });
        s.type('ls');
        s.key('Enter');
        expect(s.pty).toBe('ls\r');
        expect(s.chunks.filter((c) => c === '\r')).toHaveLength(1);
    });

    it('输入行路由（barMode=true 也接线时）：同样恰好一次 —— sendLine 两种口径下都对', () => {
        const s = makeSurface({ policy: 'sticky', barMode: true });
        s.type('ls');
        s.key('Enter');
        // 增量观测已经把 "ls" 送出去了，sendLine 的补观测 emit 为空 ⇒ 不重复。
        expect(s.pty).toBe('ls\r');
    });

    it('连发两行不串味：第一行的残留不会跟着第二行再进一次 PTY', () => {
        const s = makeSurface({ policy: 'sticky', barMode: false });
        s.type('ls');
        s.key('Enter');
        s.type('pwd');
        s.key('Enter');
        expect(s.pty).toBe('ls\rpwd\r');
    });

    it('CR 边界把字段收干净（sticky 下这是唯一的常规回收点）', () => {
        const s = makeSurface({ policy: 'sticky', barMode: false });
        s.type('ls');
        expect(s.field).toBe('ls');
        s.key('Enter');
        expect(s.field).toBe('');
    });

    it('Ctrl+C 同样收字段（照抄 xterm 的 ETX 规则），且不吐出多余字节', () => {
        const s = makeSurface({ policy: 'sticky', barMode: false });
        s.type('rm -rf');
        s.key('c', { ctrlKey: true });
        expect(s.field).toBe('');
        // VT_BYTES 里没有 'c'，所以这里只验字段被收干净、没有额外文本重发。
        expect(s.pty).toBe('rm -rf');
    });

    it('退格走 VT，字段**不**跟着变 —— 单调 diff 因此永远只发新字符（不会双删）', () => {
        const s = makeSurface({ policy: 'sticky', barMode: false });
        s.type('abc');
        s.key('Backspace');
        s.type('d');
        // a,b,c,退格,d ⇒ PTY 上是 "abc" + 一个 DEL + "d"
        expect(s.pty).toBe('abc\x7fd');
        expect(s.chunks.filter((c) => c === '\x7f')).toHaveLength(1);
    });

    it('sticky 下 idle tick 永不清空（软键盘的模型必须留着，否则退格哑掉）', () => {
        const s = makeSurface({ policy: 'sticky', barMode: false });
        s.type('abc');
        s.tick(999_999);
        expect(s.field).toBe('abc');
        expect(s.pty).toBe('abc');
    });
});

// ════════════════════════════════════════════════════════════════════════
// 合成在途停手：**tick 绝不把 preedit 当正文发出去**（2026-08-14 实证泄漏）
// ════════════════════════════════════════════════════════════════════════

/**
 * 现场：`?input=own` 下打一半拼音去候选窗翻页（**翻页不产生 `compositionupdate`**），
 * 停手 6.6s 后 PTY 里出现 `"ni hao"`，随后模型自己发 6 个 `\x7f` 纠正；
 * `?input=xterm` 无此现象。泄漏点与原兜底阈值 5s 一致。
 *
 * 下面每个用例都跑到远超阈值的时间（tick 是 250ms 一次，这里直接 +60s），
 * 于是"重新加一条按时钟观测的兜底"必然把其中至少一条打红。
 */
describe('合成在途的 tick 不泄漏 preedit（原兜底 tick 的回归锚）', () => {
    const FAR = 999_999; // 远超 COMPOSITION_STALE_MS

    it('停手多久都不发：拉丁 preedit 留在字段里，PTY 一个字节没有', () => {
        const s = makeSurface({ policy: 'clear-on-idle', barMode: false });
        s.compositionStart();
        s.preedit('ni hao');
        for (let t = 0; t <= FAR; t += 250) s.tick(t); // 停手，只有 tick 在走
        expect(s.pty).toBe('');
        expect(s.field).toBe('ni hao');
        // 合成期也绝不清空字段（清了会打断在途 preedit）。
        expect(s.composing).toBe(true);
    });

    it('边界 ①（非合成 input，IME 中止/切走）：停手很久之后仍一次补齐，不吞字', () => {
        const s = makeSurface({ policy: 'clear-on-idle', barMode: false });
        s.compositionStart();
        s.preedit('ni hao');
        for (let t = 0; t <= FAR; t += 250) s.tick(t);
        expect(s.pty).toBe('');
        s.plainInput('ni hao'); // 浏览器：合成结束了，这是当前字段全量
        expect(s.pty).toBe('ni hao');
    });

    it('边界 ②（compositionend）：提交的是汉字，而且只有汉字', () => {
        const s = makeSurface({ policy: 'clear-on-idle', barMode: false });
        s.compositionStart();
        s.preedit('ni hao');
        for (let t = 0; t <= FAR; t += 250) s.tick(t);
        s.compositionEnd('你好');
        // 关键：PTY 上没有 "ni hao"，也没有纠正用的 \x7f —— 一次干净的提交。
        expect(s.pty).toBe('你好');
        expect(s.pty.includes('\x7f')).toBe(false);
        expect(s.composing).toBe(false);
    });

    it('边界 ③（blur）：焦点离开时把在途内容恰好提交一次', () => {
        const s = makeSurface({ policy: 'clear-on-idle', barMode: false });
        s.compositionStart();
        s.preedit('ni hao');
        for (let t = 0; t <= FAR; t += 250) s.tick(t);
        s.blur();
        expect(s.pty).toBe('ni hao'); // 迟到总比吞掉好，且这是浏览器给的真边界
        // 迟到的 compositionend 不会重复发（模型是单调 diff）。
        s.compositionEnd('ni hao');
        expect(s.pty).toBe('ni hao');
    });

    it('正常快打（无合成）不受影响：tick 不观测也不会漏字', () => {
        const s = makeSurface({ policy: 'clear-on-idle', barMode: false });
        s.type('ls -la');
        expect(s.pty).toBe('ls -la'); // 每个非合成 input 都已观测过
        for (let t = 0; t <= FAR; t += 250) s.tick(t);
        expect(s.pty).toBe('ls -la'); // idle 清空只清字段，不发字节
        expect(s.field).toBe('');
    });
});

// ════════════════════════════════════════════════════════════════════════
// 结构约束（spec §可测试性 / §验收标准 的 grep 断言）
// ════════════════════════════════════════════════════════════════════════

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

/**
 * 结构断言要看的是**代码**，不是注释 —— 这些文件的注释里大量出现
 * "不要用 disableStdin"、"never term.focus()"、"`compositionupdate.data` 一个字节
 * 都不读" 这类反面教材引用；不剥注释的话，写得越清楚越容易把自己的测试挂掉
 * （而且会诱导后人删注释来过测试，正好是反效果）。
 * 逐行小状态机：认引号与模板串，其余的 `//` 与 `/* * /` 一律剥掉。
 */
function stripComments(src: string): string {
    let out = '';
    let i = 0;
    let quote: string | null = null;
    let block = false;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (block) {
            if (c === '*' && n === '/') { block = false; i += 2; continue; }
            if (c === '\n') out += c;
            i++;
            continue;
        }
        if (quote) {
            out += c;
            if (c === '\\') { out += n ?? ''; i += 2; continue; }
            if (c === quote) quote = null;
            i++;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
        if (c === '/' && n === '*') { block = true; i += 2; continue; }
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

describe('结构约束', () => {
    const host = stripComments(read('./termInputHost.ts'));
    const diag = stripComments(read('./termInputDiag.ts'));
    const elmod = stripComments(read('./termInputElement.ts'));
    const xtermRenderer = stripComments(read('./renderer/xtermRenderer.ts'));
    const screen = stripComments(read('./WebTerminalScreen.tsx'));
    const css = read('./terminal.css');

    it('新输入模块没有 window 级监听器（app 快捷键必须先手）', () => {
        for (const [name, src] of [['termInputHost', host], ['termInputDiag', diag], ['termInputElement', elmod]] as const) {
            expect(`${name}: ${/window\.addEventListener/.test(src)}`).toBe(`${name}: false`);
            // capture-phase 注册的第三个实参也一并封死：`addEventListener(x, y, true)`
            // 与 `{capture: true}` 都不许出现在输入模块里。
            expect(`${name}: ${/addEventListener\([^)]*,\s*true\s*\)/.test(src)}`).toBe(`${name}: false`);
            expect(`${name}: ${/capture:\s*true/.test(src)}`).toBe(`${name}: false`);
        }
    });

    it('只补发 keydown，绝不补发 keyup（_keyUp 里的 this.focus() 会抢焦点）', () => {
        expect(xtermRenderer.includes("'keyup'")).toBe(false);
        expect(xtermRenderer.includes('"keyup"')).toBe(false);
        const dispatches = xtermRenderer.match(/new KeyboardEvent\('([a-z]+)'/g) ?? [];
        expect(dispatches).toEqual(["new KeyboardEvent('keydown'"]);
    });

    it('安全带装了，且不许用 disableStdin（它会连 term.paste() 一起废掉）', () => {
        expect(host.includes('attachCustomKeyEventHandler((ev) => ev.isTrusted === false)')).toBe(true);
        for (const [name, src] of [['termInputHost', host], ['xtermRenderer', xtermRenderer], ['WebTerminalScreen', screen]] as const) {
            expect(`${name}: ${src.includes('disableStdin')}`).toBe(`${name}: false`);
        }
    });

    it('输入元素挂在 term.element 内部（⌘C 复制选区 / host 层文件粘贴 capture 的前提）', () => {
        // root = term.element；挂载点是它的后代 `.xterm-helpers`（或退化成 root 自己）。
        expect(host.includes('const root = term.element')).toBe(true);
        expect(host.includes("root.querySelector('.xterm-helpers')")).toBe(true);
        expect(host.includes('helpers.appendChild(el)')).toBe(true);
        // 绝不允许挂到 document.body / host 容器上。
        expect(/document\.body\.appendChild/.test(host)).toBe(false);
    });

    it('`.vh-term-input` 恒 ≤1 个：只有一处创建，且被唯一一处 own 分支守卫', () => {
        expect((host.match(/createElement\('textarea'\)/g) ?? []).length).toBe(1);
        expect((screen.match(/installTermInput\(/g) ?? []).length).toBe(1);
        expect(screen.includes("if (inputOwnership === 'own') {")).toBe(true);
        // 开关是 effect 依赖 ⇒ 翻开关会重建终端，两条路径不可能并存。
        expect(screen.includes('}, [machineId, tid, inputOwnership]);')).toBe(true);
        // 旧路径的 imeStuckGuard 在 own 模式下不安装。
        expect(screen.includes("if (inputOwnership !== 'own') imeGuard = installImeStuckGuard(term);")).toBe(true);
    });

    it('8 个耦合点：屏幕里不再出现 helper textarea 的 class 名或 term.focus()', () => {
        expect(screen.includes('xterm-helper-textarea')).toBe(false);
        expect(/\bterm\.focus\(\)/.test(screen)).toBe(false);
        expect(/\bterm\.blur\(\)/.test(screen)).toBe(false);
    });

    it('CSS：pointer-events / user-select / caret 三条纪律都在（R6 + 单光标）', () => {
        const block = css.slice(css.indexOf('.vh-term-input {'));
        expect(block.includes('pointer-events: none;')).toBe(true);
        expect(block.includes('user-select: none;')).toBe(true);
        expect(block.includes('caret-color: transparent;')).toBe(true);
        expect(block.includes('background: transparent;')).toBe(true);
        expect(block.includes('white-space: pre;')).toBe(true);
        expect(block.includes('overflow: hidden;')).toBe(true);
    });

    it('宿主不自己读 compositionupdate.data（spec §B ① 的"零 JS 镜像"）', () => {
        expect(host.includes('.data')).toBe(false);
    });

    it('Step 2：两条路径互斥 —— own 时不装 mobileInputBridge（否则两个 diff 引擎同时镜像）', () => {
        expect(screen.includes("if (inputOwnership !== 'own') mobileBridge = installMobileInputBridge(term, sendInput);")).toBe(true);
        // 装桥只有这一处，且就在上面那行里。
        expect((screen.match(/installMobileInputBridge\(/g) ?? []).length).toBe(1);
    });

    it('Step 2：设备只影响策略与呈现，不影响开关解析', () => {
        expect(screen.includes('policy: pickFieldPolicy(IS_COARSE_POINTER)')).toBe(true);
        expect(screen.includes('coarsePointer: IS_COARSE_POINTER')).toBe(true);
        // 开关解析里不再传设备。
        const call = screen.slice(screen.indexOf('resolveInputOwnership({'));
        expect(call.slice(0, call.indexOf('})')).includes('coarsePointer')).toBe(false);
    });

    it('Step 2：overlay 恒为逐键面 —— barMode 恒 false（输入行模式是另一个元素的事）', () => {
        expect(screen.includes('barMode: () => false')).toBe(true);
        // 输入行模式的输入面在 term.element 之外：它由 React 渲染进 .term-bottombars，
        // 发送直接走 sendInputRef（= 同一个 sendInput 出口），与本宿主零交集。
        expect(screen.includes('<TermInputBar')).toBe(true);
        expect(screen.includes("onSend={(text) => sendInputRef.current?.(toPtyText(text) + '\\r')}")).toBe(true);
    });

    it('宿主只监听自己的元素与 term.element —— 观测不到输入行的 textarea（双发的结构性理由）', () => {
        const targets = [...host.matchAll(/(\w+)\.addEventListener\(/g)].map((m) => m[1]);
        expect(targets.length).toBeGreaterThan(0);
        expect([...new Set(targets)].sort()).toEqual(['el', 'root']);
        expect(/document\.addEventListener/.test(host)).toBe(false);
    });

    it('CSS：粗指针静止不可见（sticky 下常显会与 PTY 回显叠字）', () => {
        const coarse = css.slice(css.indexOf('.vh-term-input.is-coarse {'));
        expect(coarse.startsWith('.vh-term-input.is-coarse {\n  opacity: 0;\n}')).toBe(true);
    });

    it('CSS：合成气泡对**两端**生效，且排在 .is-coarse 之后（同特异性，后者赢 opacity）', () => {
        // 桌面也要气泡：preedit 与终端正文同字体同前景色 ⇒ 看起来就是"已经打进去的
        // 英文"，这是"以为中文输入法坏了"的直接原因（旧路径靠 xterm 的 teal 气泡区分）。
        const bubble = '.vh-term-input.is-composing {';
        expect(css.includes(bubble)).toBe(true);
        // 不能再是 `.is-coarse.is-composing` 复合选择器（那样桌面永远拿不到气泡）。
        expect(css.includes('.vh-term-input.is-coarse.is-composing {')).toBe(false);
        expect(css.indexOf(bubble)).toBeGreaterThan(css.indexOf('.vh-term-input.is-coarse {'));
        const block = css.slice(css.indexOf(bubble), css.indexOf('}', css.indexOf(bubble)));
        expect(block.includes('opacity: 1;')).toBe(true);
        // 不透明底 + teal 边框 = "这是输入法在合成"的一眼可辨观感。
        expect(block.includes('background: #181f2a;')).toBe(true);
        expect(block.includes('outline: 1px solid #34e2c4;')).toBe(true);
        // 气泡用 outline 而不是 border：border-box + 抄来的 inline 宽高下，
        // 1px border 会吃掉内容盒把 preedit 削顶。
        expect(/border:\s/.test(block)).toBe(false);
        // 也不许有 box-shadow —— 这个元素上任何"发光"都是 bug 1 的形态。
        expect(block.includes('box-shadow')).toBe(false);
    });

    it('CSS：`.vh-term-input` 上焦点环被彻底掐掉（outline **和** box-shadow）', () => {
        const block = css.slice(css.indexOf('.vh-term-input {'), css.indexOf('.vh-term-input.is-coarse {'));
        // 原 bug：作者写了 outline: none，但全局焦点环画的是 box-shadow（3px teal
        // glow）⇒ 一个跟着光标走的绿框。两条都要在。
        expect(block.includes('outline: none;')).toBe(true);
        expect(block.includes('box-shadow: none;')).toBe(true);
        expect(css.includes('.vh-term-input:focus,\n.vh-term-input:focus-visible {')).toBe(true);
    });

    it('base.css 的全局焦点环把终端 pane 结构性排除，且**不改变特异性**', () => {
        const base = read('../../styles/base.css');
        // `:where()` 在 `:not()` 里贡献 0 特异性 ⇒ 选择器仍是 (0,1,0)，既有组件
        // 覆盖的胜负关系一个都不变；这条修正只可能"少画"，不可能重排层叠。
        expect(base.includes(':focus-visible:not(:where(.xterm, .xterm *)) {')).toBe(true);
        // 裸的元素级 `:focus-visible {` 不许再出现（那是绿框的来源）。
        expect(/(^|\n):focus-visible\s*\{/.test(base)).toBe(false);
        // 环本身还在（无障碍要求：全站控件默认有可见焦点环，不是逐个 opt-in）。
        const ring = base.slice(base.indexOf(':focus-visible:not('));
        expect(ring.includes('box-shadow: 0 0 0 3px var(--accent-glow);')).toBe(true);
    });

    it('宿主的定时器不观测输入域 —— observe 只挂在三个真实边界上', () => {
        // 定时器体里不许出现 observe()：那正是"停滞就无条件观测"的形状。
        const timer = host.slice(host.indexOf('const timer = setInterval('));
        const body = timer.slice(0, timer.indexOf('}, tickMs);'));
        expect(body.includes('observe()')).toBe(false);
        // 它只做三件不产生字节的事 + 记数。
        expect(body.includes('tallyCompositionStale(')).toBe(true);
        expect(body.includes("apply({ type: 'tick', now: t })")).toBe(true);
        expect(body.includes('syncGeometry()')).toBe(true);
        expect(body.includes('syncPreedit()')).toBe(true);
        // 全文件里只有一处**调用**（`onInput` 的 `{ kind: 'input' }`）；
        // `composition-end`/`blur` 两条边界恒观测，直接 observe()。
        expect((host.match(/shouldObserveField\(\{/g) ?? []).length).toBe(1);
        expect(host.includes("shouldObserveField({ kind: 'tick'")).toBe(false);
        // observe() 的调用点：onCompositionEnd(+0ms 补跑) / onBlur / sendLine / onInput。
        expect((host.match(/observe\(\);/g) ?? []).length).toBe(5);
    });

    it('停滞计数器只进诊断快照，不进任何判断（记数 ≠ 动作）', () => {
        const diagCounters = stripComments(read('./termDiag.ts'));
        expect(diagCounters.includes('compositionStaleSeen: number;')).toBe(true);
        expect(screen.includes('compositionStaleSeen: ownInput?.counters.compositionStaleSeen ?? 0')).toBe(true);
        // 接线层（installTermInput 的函数体）里这个量只被 tally 更新、只被 counters
        // 的 getter 读出，**绝不出现在任何 if 里**（那就变回闸门了）。纯判定函数
        // `isCompositionStale`/`tallyCompositionStale` 自己当然要分支，不在此列。
        const wiring = host.slice(host.indexOf('export function installTermInput'));
        expect(/if\s*\([^)]*stale/i.test(wiring)).toBe(false);
        expect(wiring.includes('get compositionStaleSeen() { return stale.seen; }')).toBe(true);
    });

    it('合成气泡两端都装：syncPreedit 不再按粗指针提前返回', () => {
        const sync = host.slice(host.indexOf('const syncPreedit = ()'));
        const body = sync.slice(0, sync.indexOf('};'));
        expect(body.includes('!coarse')).toBe(false);
        expect(body.includes('shouldShowPreedit(')).toBe(true);
        expect(body.includes('classList.toggle(COMPOSING_CLASS, on)')).toBe(true);
    });

    it('宿主不重写规则：路由与模型都是 import 来的', () => {
        expect(host.includes("from './termInputRoute'")).toBe(true);
        expect(host.includes("from './termInputModel'")).toBe(true);
        // 不许出现自己搓的 VT 序列（Phase 1 复用 xterm 的编码器）。
        expect(/\\x1b\[/.test(host)).toBe(false);
    });
});
