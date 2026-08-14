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
    shouldObserveField,
    pickOverlayWidth,
    mirrorFocusAction,
    resolveInputOwnership,
} from './termInputHost';

describe('shouldObserveField —— ★ 宿主观测时机的四条规则', () => {
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

    it('④ 兜底 tick：距上一次 composition 事件超过 5s 才无条件观测', () => {
        const t0 = 1_000_000;
        expect(shouldObserveField({ kind: 'tick', now: t0, lastCompositionAt: t0 })).toBe(false);
        expect(shouldObserveField({
            kind: 'tick', now: t0 + COMPOSITION_STALE_MS, lastCompositionAt: t0,
        })).toBe(false);
        expect(shouldObserveField({
            kind: 'tick', now: t0 + COMPOSITION_STALE_MS + 1, lastCompositionAt: t0,
        })).toBe(true);
    });

    it('④ 是自过期的：从未合成过（lastCompositionAt=0）时 tick 一直观测', () => {
        // 桌面稳态就是这条 —— observe 幂等，所以"一直观测"= 一直什么都不发。
        expect(shouldObserveField({ kind: 'tick', now: Date.now(), lastCompositionAt: 0 })).toBe(true);
    });

    it('活跃合成会不断续命，兜底永不在正常路径上开火', () => {
        // compositionupdate 每次刷新 lastCompositionAt：只要 IME 还在发事件，
        // now - last 永远是一个小数，兜底不触发。
        let last = 0;
        for (let t = 0; t < 60_000; t += 300) {
            last = t; // 一次 compositionupdate
            expect(shouldObserveField({ kind: 'tick', now: t + 250, lastCompositionAt: last })).toBe(false);
        }
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

describe('resolveInputOwnership —— 设置 ⊕ URL 覆盖 ⊕ Step 1 设备门', () => {
    const desktop = { coarsePointer: false };

    it('默认（无设置无参数）= 旧路径', () => {
        expect(resolveInputOwnership({ ...desktop, setting: undefined, urlParam: null })).toBe('xterm');
    });

    it('设置生效', () => {
        expect(resolveInputOwnership({ ...desktop, setting: 'own', urlParam: null })).toBe('own');
        expect(resolveInputOwnership({ ...desktop, setting: 'xterm', urlParam: null })).toBe('xterm');
    });

    it('?input= 覆盖设置（两个方向都要能覆盖 —— golden 差分要在同一构建上跑两轮）', () => {
        expect(resolveInputOwnership({ ...desktop, setting: 'xterm', urlParam: 'own' })).toBe('own');
        expect(resolveInputOwnership({ ...desktop, setting: 'own', urlParam: 'xterm' })).toBe('xterm');
    });

    it('无法识别的 ?input= 值被忽略，回落到设置', () => {
        expect(resolveInputOwnership({ ...desktop, setting: 'own', urlParam: 'yes' })).toBe('own');
        expect(resolveInputOwnership({ ...desktop, setting: 'own', urlParam: '' })).toBe('own');
    });

    it('粗指针设备强制旧路径 —— 否则会和 mobileInputBridge 同时激活（双发，R4）', () => {
        expect(resolveInputOwnership({ coarsePointer: true, setting: 'own', urlParam: 'own' })).toBe('xterm');
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

    it('宿主不重写规则：路由与模型都是 import 来的', () => {
        expect(host.includes("from './termInputRoute'")).toBe(true);
        expect(host.includes("from './termInputModel'")).toBe(true);
        // 不许出现自己搓的 VT 序列（Phase 1 复用 xterm 的编码器）。
        expect(/\\x1b\[/.test(host)).toBe(false);
    });
});
