/**
 * `window.__vhTermInput` 的契约测试 —— golden 按键扫描工具直接依赖这个形状，
 * 改了它就等于悄悄废掉 Step 1 唯一的自动化护栏（spec §R3：Step 1 未跑通按键扫描
 * 不得进入 Step 3）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { installTermInputDiag, classifyRouted, modString } from './termInputDiag';
import type { KeyEventLike, RouteDecision } from './termInputRoute';

const g = globalThis as unknown as Record<string, any>;
const handles: Array<{ dispose(): void }> = [];
const install = (opts: Parameters<typeof installTermInputDiag>[0]) => {
    const h = installTermInputDiag(opts);
    handles.push(h);
    return h;
};
afterEach(() => {
    for (const h of handles.splice(0)) h.dispose();
});

const key = (o: Partial<KeyEventLike>): KeyEventLike => ({
    key: 'a', code: 'KeyA', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o,
});
const VT: RouteDecision = { kind: 'vt', preventDefault: true };

describe('installTermInputDiag', () => {
    it('关闭时是零成本空壳，且不挂全局（生产默认路径）', () => {
        install({ enabled: false, ownership: 'own' });
        expect(g.__vhTermInput).toBeUndefined();
    });

    it('契约：ownership / routed / emitted / clear / snapshot', () => {
        const h = install({ enabled: true, ownership: 'own', now: () => 7 });
        h.noteRouted(key({ key: 'Tab', code: 'Tab', keyCode: 9 }), VT);
        h.noteEmitted('\t');
        const api = g.__vhTermInput;
        expect(api.ownership).toBe('own');
        expect(api.routed).toEqual([{
            at: 7, key: 'Tab', code: 'Tab', keyCode: 9, mods: '',
            isComposing: false, defaultPrevented: false, kind: 'vt', preventDefault: true,
        }]);
        // emitted 记的是**实际写入 PTY 的字符串**（差分工具逐字节比对的对象）。
        expect(api.emitted).toEqual([{ at: 7, data: '\t' }]);
        expect(api.snapshot()).toEqual({
            ownership: 'own', routed: api.routed, emitted: api.emitted,
        });
        api.clear();
        expect(api.routed).toEqual([]);
        expect(api.emitted).toEqual([]);
    });

    it('两条路径都记 emitted（xterm 路径没有 routed，但字节序列必须可比）', () => {
        const h = install({ enabled: true, ownership: 'xterm' });
        h.noteEmitted('\x1b[A');
        expect(g.__vhTermInput.ownership).toBe('xterm');
        expect(g.__vhTermInput.emitted.map((e: any) => e.data)).toEqual(['\x1b[A']);
    });

    it('环形缓冲上限 200（spec 定值），只留最近的', () => {
        const h = install({ enabled: true, ownership: 'own' });
        for (let i = 0; i < 250; i++) h.noteEmitted(String(i));
        const data = g.__vhTermInput.emitted.map((e: any) => e.data);
        expect(data.length).toBe(200);
        expect(data[0]).toBe('50');
        expect(data[199]).toBe('249');
    });

    it('返回的数组是拷贝：控制台里改它不影响缓冲（钩子是只读的）', () => {
        const h = install({ enabled: true, ownership: 'own' });
        h.noteEmitted('x');
        g.__vhTermInput.emitted.push({ at: 0, data: 'injected' });
        expect(g.__vhTermInput.emitted.map((e: any) => e.data)).toEqual(['x']);
    });

    it('dispose 只摘自己挂的那一个（StrictMode 双挂时后挂的必须活下来）', () => {
        const first = installTermInputDiag({ enabled: true, ownership: 'own' });
        const second = install({ enabled: true, ownership: 'xterm' });
        first.dispose(); // 先挂的先卸
        expect(g.__vhTermInput?.ownership).toBe('xterm');
        second.dispose();
        expect(g.__vhTermInput).toBeUndefined();
    });
});

describe('classifyRouted / modString', () => {
    it('修饰键位串顺序稳定', () => {
        expect(modString({})).toBe('');
        expect(modString({ ctrlKey: true })).toBe('c-');
        expect(modString({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })).toBe('c-a-s-m-');
        expect(modString({ shiftKey: true, ctrlKey: true })).toBe('c-s-');
    });

    it('IME 与 P0 的两个关键位被记下来（"这一击到底被谁吃了"）', () => {
        const e = classifyRouted(
            key({ keyCode: 229, isComposing: true }),
            { kind: 'ime', preventDefault: false },
            1,
        );
        expect(e.isComposing).toBe(true);
        expect(e.keyCode).toBe(229);
        expect(e.kind).toBe('ime');
        const p0 = classifyRouted(key({ defaultPrevented: true }), { kind: 'app', preventDefault: false }, 1);
        expect(p0.defaultPrevented).toBe(true);
    });
});
