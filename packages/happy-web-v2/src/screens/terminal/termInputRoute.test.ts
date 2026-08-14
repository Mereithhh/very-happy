/**
 * `routeKey` 的路由表回归 —— spec §设计 C（P0-P8）与 §可测试性 表里「路由」那几行。
 *
 * 每一条都钉住两件事：`kind`（谁负责这一击）与 `preventDefault`（要不要吃掉默认行为）。
 * 后者是双通路事故（spec §风险 R4）与"某个键静默失效"（§风险 R3）的唯一自动化防线。
 *
 * node 环境无 DOM：事件是鸭子类型（同 `closeGuard.test.ts` / `termFocusOwnership.test.ts`）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routeKey, type KeyEventLike, type RouteCtx, type RouteDecision } from './termInputRoute';

function key(over: Partial<KeyEventLike> = {}): KeyEventLike {
    return {
        key: '', code: '',
        metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
        ...over,
    };
}

const MODES = { applicationCursorKeysMode: false, applicationKeypadMode: false };
const MAC: RouteCtx = { isMac: true, barMode: false, modes: MODES };
const PC: RouteCtx = { isMac: false, barMode: false, modes: MODES };
const MAC_BAR: RouteCtx = { ...MAC, barMode: true };

const r = (over: Partial<KeyEventLike>, ctx: RouteCtx = MAC): RouteDecision => routeKey(key(over), ctx);

describe('routeKey — P0 上层已消费', () => {
    it('defaultPrevented 恒 app，且不再自己 preventDefault', () => {
        // app 级快捷键全是 window+capture 且 preventDefault+stopPropagation，
        // DOM 派发顺序保证它们先手；我们只需让位。
        expect(r({ defaultPrevented: true, key: 'k', metaKey: true })).toEqual({ kind: 'app', preventDefault: false });
        expect(r({ defaultPrevented: true, key: 'Escape' })).toEqual({ kind: 'app', preventDefault: false });
        // P0 优先于一切 —— 连 Tab（正常要 preventDefault 的键）也让位。
        expect(r({ defaultPrevented: true, key: 'Tab' }).kind).toBe('app');
        // 甚至优先于 P1：上层已经处置过就是处置过。
        expect(r({ defaultPrevented: true, key: 'Process', keyCode: 229 }).kind).toBe('app');
    });
});

describe('routeKey — P1 IME（无状态判据，根治的核心）', () => {
    // 判据全部来自事件本身，不读任何持久标志：这正是 `_isComposing` 卡死不可能
    // 再发生的原因。三种上报形态（Chrome/Safari/Firefox/Android）都必须命中。
    const cases: Array<[string, Partial<KeyEventLike>]> = [
        ['isComposing:true + Enter（合成中按回车确认候选）', { isComposing: true, key: 'Enter' }],
        ['keyCode 229（软键盘/IME 哨兵）', { keyCode: 229, key: 'Unidentified' }],
        ["key === 'Process'（Firefox/IE 系）", { key: 'Process' }],
        ['isComposing 中的方向键（候选窗翻页）', { isComposing: true, key: 'ArrowDown' }],
        ['isComposing 中的退格（改拼音）', { isComposing: true, key: 'Backspace' }],
        ['isComposing 中的 Tab', { isComposing: true, key: 'Tab' }],
    ];
    for (const [name, ev] of cases) {
        it(`${name} → ime，绝不 preventDefault`, () => {
            expect(r(ev)).toEqual({ kind: 'ime', preventDefault: false });
            expect(r(ev, PC)).toEqual({ kind: 'ime', preventDefault: false });
            expect(r(ev, MAC_BAR)).toEqual({ kind: 'ime', preventDefault: false });
        });
    }

    it('P1 早于 P5：合成中的 Enter 绝不被当成 VT 键送 \\r', () => {
        expect(r({ isComposing: true, key: 'Enter' }).kind).not.toBe('vt');
        expect(r({ isComposing: true, key: 'Enter' }, MAC_BAR).kind).not.toBe('send-line');
    });

    it('同一个键不带 IME 标记时正常路由（判定只看这一次事件）', () => {
        expect(r({ key: 'Enter' }).kind).toBe('vt');
        expect(r({ isComposing: false, key: 'Enter' }).kind).toBe('vt');
    });
});

describe('routeKey — P2 ⌘ 组合一律不进 PTY', () => {
    it('⌘C/⌘V/⌘X/⌘A 归 clipboard 且放行给原生', () => {
        for (const k of ['c', 'v', 'x', 'a']) {
            expect(r({ key: k, code: `Key${k.toUpperCase()}`, metaKey: true }))
                .toEqual({ kind: 'clipboard', preventDefault: false });
        }
        // Shift 变大写（⌘⇧C）同样是剪贴板语义的一族，不进 PTY。
        expect(r({ key: 'C', metaKey: true, shiftKey: true }).kind).toBe('clipboard');
    });

    it('其余 ⌘ 组合 ignore（不发字节、也不吃默认行为）', () => {
        expect(r({ key: 'z', metaKey: true })).toEqual({ kind: 'ignore', preventDefault: false });
        expect(r({ key: 'Enter', metaKey: true })).toEqual({ kind: 'ignore', preventDefault: false });
        expect(r({ key: 'ArrowLeft', metaKey: true }).kind).toBe('ignore');
    });
});

describe('routeKey — P3 剪贴板惯例键', () => {
    it('非 mac 的 Ctrl+Shift+C/V 是剪贴板，不是 ^C/^V', () => {
        expect(r({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }, PC))
            .toEqual({ kind: 'clipboard', preventDefault: false });
        expect(r({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }, PC).kind).toBe('clipboard');
    });

    it('mac 上 ⌃⇧C 不是剪贴板（走 P5 的 ctrl 兜底，与 xterm 一致）', () => {
        expect(r({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }, MAC).kind).toBe('vt');
    });

    it('Shift+Insert 是粘贴（两个平台都是）', () => {
        expect(r({ key: 'Insert', shiftKey: true }, PC).kind).toBe('clipboard');
        expect(r({ key: 'Insert', shiftKey: true }, MAC).kind).toBe('clipboard');
        // 裸 Insert 仍是 VT 键。
        expect(r({ key: 'Insert' }, PC).kind).toBe('vt');
    });
});

describe('routeKey — P4 mac 的 ⌥ 是第三级 shift', () => {
    it('⌥w（key 为 ∑）交给输入域，不 preventDefault', () => {
        // macOptionIsMeta 保持 false：浏览器会把 ∑ 插进输入域，diff 负责送进 PTY。
        expect(r({ key: '∑', code: 'KeyW', altKey: true }, MAC))
            .toEqual({ kind: 'text', preventDefault: false });
        expect(r({ key: '¬', code: 'KeyL', altKey: true }, MAC).kind).toBe('text');
    });

    it('⌥+死键（⌥n 起头的组合）也归输入域', () => {
        expect(r({ key: 'Dead', code: 'KeyN', altKey: true }, MAC).kind).toBe('text');
    });

    it('⌥+方向键仍是 VT（不是字符键）', () => {
        expect(r({ key: 'ArrowLeft', altKey: true }, MAC)).toEqual({ kind: 'vt', preventDefault: true });
    });

    it('非 mac 的 Alt+字符是 Meta 前缀（ESC+char）⇒ VT', () => {
        // 偏离 spec P4：那一行只描述了 mac。非 mac 上浏览器不会把 Alt 组合插进输入域，
        // 落 P7 等于什么都不发（readline 的 M-b/M-f 全哑）。
        expect(r({ key: 'b', code: 'KeyB', altKey: true }, PC)).toEqual({ kind: 'vt', preventDefault: true });
    });
});

describe('routeKey — P5 非文本键与控制组合', () => {
    const vtKeys = [
        'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Home', 'End', 'PageUp', 'PageDown', 'Insert',
        'F1', 'F5', 'F12',
    ];
    for (const k of vtKeys) {
        it(`${k} → vt + preventDefault`, () => {
            expect(r({ key: k })).toEqual({ kind: 'vt', preventDefault: true });
        });
    }

    it('Tab / Shift+Tab 必须 preventDefault（否则焦点跑掉、claude 补全没了）', () => {
        expect(r({ key: 'Tab', code: 'Tab' })).toEqual({ kind: 'vt', preventDefault: true });
        expect(r({ key: 'Tab', code: 'Tab', shiftKey: true })).toEqual({ kind: 'vt', preventDefault: true });
    });

    it('Ctrl+C 无论有无选区都送 \\x03（复制走 ⌘C / P3）', () => {
        expect(r({ key: 'c', code: 'KeyC', ctrlKey: true })).toEqual({ kind: 'vt', preventDefault: true });
    });

    it('Ctrl+字母 / Ctrl+[ ] \\ ^ _ Space 都归 VT', () => {
        for (const k of ['a', 'd', 'z', '[', ']', '\\', '^', '_', ' ']) {
            expect(r({ key: k, ctrlKey: true }).kind).toBe('vt');
        }
    });

    it('Ctrl/Shift+方向键归 VT（修饰位由编码器处理）', () => {
        expect(r({ key: 'ArrowRight', ctrlKey: true }).kind).toBe('vt');
        expect(r({ key: 'ArrowRight', shiftKey: true }).kind).toBe('vt');
    });

    it('AltGr（Ctrl+Alt，欧洲布局的 €）必须归输入域，不是 Ctrl 组合', () => {
        // spec P5 的「Ctrl+字母」照字面会把 AltGr 送去 VT ⇒ 打不出 €。
        // xterm 的编码器同样要求 !altKey 才走 ctrl 分支。
        expect(r({ key: '€', code: 'KeyE', ctrlKey: true, altKey: true }, PC))
            .toEqual({ kind: 'text', preventDefault: false });
    });

    it('小键盘 + DECKPAM 走 VT（应用小键盘模式发 SS3 而不是字面字符）', () => {
        const kpOff = r({ key: '5', code: 'Numpad5', location: 3 }, MAC);
        expect(kpOff.kind).toBe('text');
        const appKp: RouteCtx = { ...MAC, modes: { ...MODES, applicationKeypadMode: true } };
        expect(r({ key: '5', code: 'Numpad5', location: 3 }, appKp)).toEqual({ kind: 'vt', preventDefault: true });
    });
});

describe('routeKey — P6 输入行模式的 Enter', () => {
    it('barMode 下 Enter 送整行（就地模式下同一个键落 P5）', () => {
        // 偏离 spec 表序：P5 的具名集合含 Enter，照 P5→P6 的顺序 P6 是死代码。
        expect(r({ key: 'Enter' }, MAC_BAR)).toEqual({ kind: 'send-line', preventDefault: true });
        expect(r({ key: 'Enter' }, MAC)).toEqual({ kind: 'vt', preventDefault: true });
    });

    it('barMode 下 Shift+Enter 是输入行内换行（TermInputBar 既有语义）', () => {
        expect(r({ key: 'Enter', shiftKey: true }, MAC_BAR)).toEqual({ kind: 'text', preventDefault: false });
    });

    it('barMode 下合成中的 Enter 仍归 IME（确认候选，绝不误发整行）', () => {
        expect(r({ key: 'Enter', isComposing: true }, MAC_BAR).kind).toBe('ime');
    });

    it('barMode 下的 Ctrl+Enter 不是整行发送', () => {
        expect(r({ key: 'Enter', ctrlKey: true }, MAC_BAR).kind).toBe('vt');
    });
});

describe('routeKey — P7 可打印键归输入域', () => {
    it('普通字符不 preventDefault（浏览器/IME 是唯一真相）', () => {
        expect(r({ key: 'a', code: 'KeyA' })).toEqual({ kind: 'text', preventDefault: false });
        expect(r({ key: 'A', code: 'KeyA', shiftKey: true }).kind).toBe('text');
        expect(r({ key: ' ', code: 'Space' }).kind).toBe('text');
        expect(r({ key: '你' }).kind).toBe('text');
        expect(r({ key: '1', code: 'Digit1' }).kind).toBe('text');
    });

    it('死键（´ + e = é）归输入域', () => {
        // spec P7 的判据只写 key.length===1，但同行依据点名了死键；死键的 key 是 'Dead'。
        expect(r({ key: 'Dead', code: 'Backquote' })).toEqual({ kind: 'text', preventDefault: false });
        expect(r({ key: 'Unidentified' })).toEqual({ kind: 'text', preventDefault: false });
    });
});

describe('routeKey — P8 忽略', () => {
    it('纯修饰键不产字符也无 VT 语义（且不被 ctrl 兜底误吞）', () => {
        expect(r({ key: 'Control', ctrlKey: true })).toEqual({ kind: 'ignore', preventDefault: false });
        expect(r({ key: 'Shift', shiftKey: true }).kind).toBe('ignore');
        expect(r({ key: 'Alt', altKey: true }, PC).kind).toBe('ignore');
        expect(r({ key: 'Meta', metaKey: true }).kind).toBe('ignore'); // 走 P2 的 ignore，殊途同归
        expect(r({ key: 'CapsLock' }).kind).toBe('ignore');
    });

    it('F13+ 与媒体键忽略', () => {
        expect(r({ key: 'F13' }).kind).toBe('ignore');
        expect(r({ key: 'F24' }).kind).toBe('ignore');
        expect(r({ key: 'AudioVolumeUp' }).kind).toBe('ignore');
        expect(r({ key: 'MediaPlayPause' }).kind).toBe('ignore');
    });
});

describe('routeKey — 全局不变式（R4 双通路防线）', () => {
    const sample: Array<Partial<KeyEventLike>> = [
        { defaultPrevented: true, key: 'k', metaKey: true },
        { isComposing: true, key: 'a' }, { keyCode: 229, key: 'Unidentified' }, { key: 'Process' },
        { key: 'c', metaKey: true }, { key: 'z', metaKey: true },
        { key: 'V', ctrlKey: true, shiftKey: true }, { key: 'Insert', shiftKey: true },
        { key: '∑', code: 'KeyW', altKey: true }, { key: 'b', code: 'KeyB', altKey: true },
        { key: 'Enter' }, { key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'Escape' },
        { key: 'Backspace' }, { key: 'Delete' }, { key: 'ArrowUp' }, { key: 'ArrowDown' },
        { key: 'ArrowLeft', ctrlKey: true }, { key: 'ArrowRight', shiftKey: true },
        { key: 'Home' }, { key: 'End' }, { key: 'PageUp' }, { key: 'PageDown' }, { key: 'Insert' },
        { key: 'F1' }, { key: 'F12' }, { key: 'F13' },
        { key: 'a', ctrlKey: true }, { key: ' ', ctrlKey: true }, { key: '[', ctrlKey: true },
        { key: '€', code: 'KeyE', ctrlKey: true, altKey: true },
        { key: 'a' }, { key: '你' }, { key: 'Dead' }, { key: 'Unidentified' },
        { key: 'Control', ctrlKey: true }, { key: 'CapsLock' }, { key: 'AudioVolumeUp' },
        { key: '5', code: 'Numpad5', location: 3 },
    ];
    const ctxs: RouteCtx[] = [
        MAC, PC, MAC_BAR, { ...PC, barMode: true },
        { ...MAC, modes: { applicationCursorKeysMode: true, applicationKeypadMode: true } },
    ];

    it('preventDefault ⇔ 我们自己发字节（vt / send-line）—— 表驱动全覆盖', () => {
        for (const ev of sample) {
            for (const ctx of ctxs) {
                const d = routeKey(key(ev), ctx);
                const owns = d.kind === 'vt' || d.kind === 'send-line';
                expect({ ev, ctx: ctx.isMac, kind: d.kind, pd: d.preventDefault })
                    .toEqual({ ev, ctx: ctx.isMac, kind: d.kind, pd: owns });
            }
        }
    });

    it('纯函数：同一输入恒同一输出，且不改动入参', () => {
        for (const ev of sample) {
            const e1 = key(ev);
            const snapshot = JSON.stringify(e1);
            const a = routeKey(e1, MAC);
            const b = routeKey(e1, MAC);
            expect(a).toEqual(b);
            expect(JSON.stringify(e1)).toBe(snapshot);
        }
    });

    it('DECCKM（applicationCursorKeysMode）不改变任何路由归属', () => {
        // 方向键无条件归 VT，模式只影响编码器产出的字节。若将来某条规则开始读它，
        // 这条会红 —— 那时要么改 spec，要么改实现。
        const on: RouteCtx = { ...MAC, modes: { ...MODES, applicationCursorKeysMode: true } };
        for (const ev of sample) {
            expect(routeKey(key(ev), on)).toEqual(routeKey(key(ev), MAC));
        }
    });
});

describe('结构约束（spec §可测试性 的 grep 断言）', () => {
    const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    const sources: Array<[string, string]> = [
        ['termInputRoute.ts', read('./termInputRoute.ts')],
        ['termInputModel.ts', read('./termInputModel.ts')],
    ];

    it('没有 window capture keydown 监听器（app 快捷键必须先手）', () => {
        for (const [name, src] of sources) {
            expect(`${name}: ${src.includes('addEventListener')}`).toBe(`${name}: false`);
            expect(`${name}: ${src.includes('window.')}`).toBe(`${name}: false`);
        }
    });

    it('零 DOM：不出现 document. / querySelector', () => {
        for (const [name, src] of sources) {
            expect(`${name}: ${src.includes('document.')}`).toBe(`${name}: false`);
            expect(`${name}: ${src.includes('querySelector')}`).toBe(`${name}: false`);
        }
    });

    it('零定时器、零时钟读取（时间一律由宿主注入）', () => {
        for (const [name, src] of sources) {
            for (const forbidden of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'Date.now']) {
                expect(`${name}/${forbidden}: ${src.includes(forbidden)}`).toBe(`${name}/${forbidden}: false`);
            }
        }
    });

    it('零 import 副作用：两个模块互不 import、也不 import 任何外部包', () => {
        for (const [name, src] of sources) {
            const imports = src.match(/^\s*import[\s{]/gm) ?? [];
            expect(`${name}: ${imports.length}`).toBe(`${name}: 0`);
        }
    });
});
