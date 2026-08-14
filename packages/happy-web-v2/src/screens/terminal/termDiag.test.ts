/**
 * 诊断钩子的回归测试。
 *
 * 为什么这也算"事故必附回归测试"：这个钩子本身就是事故的产物（第三次复发有一半
 * 代价来自线上问不到状态）。它必须满足三条，否则会变成新的风险面：默认不在生产
 * 挂载、缓冲只留元数据（终端里会敲密码）、缓冲有上限且可一键关掉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { classifyOnData, createRingBuffer, installTermDiag } from './termDiag';

const GLOBAL_KEY = '__vhTermDiag' as const;
const g = () => (globalThis as unknown as Record<string, any>)[GLOBAL_KEY];

const baseRead = () => ({
    focusOwner: 'nobody',
    hasOverlay: false,
    composing: false,
    guardCounters: {
        heals: 1,
        residueClears: 2,
        focusChecks: 3,
        focusRestores: 4,
        focusSkippedOverlay: 5,
        focusSkippedComposing: 6,
    },
    lastRestoreAt: 1234,
});

afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
});

describe('createRingBuffer', () => {
    it('保留最近 N 条，旧的滚掉', () => {
        const r = createRingBuffer<number>(3);
        for (const v of [1, 2, 3, 4, 5]) r.push(v);
        expect(r.toArray()).toEqual([3, 4, 5]);
        expect(r.size).toBe(3);
        expect(r.capacity).toBe(3);
    });

    it('toArray 返回拷贝（外部改不到内部状态）', () => {
        const r = createRingBuffer<number>(3);
        r.push(1);
        const a = r.toArray();
        a.push(99);
        expect(r.toArray()).toEqual([1]);
    });

    it('clear 清空；容量下限为 1（防 0/负数）', () => {
        const r = createRingBuffer<number>(0);
        r.push(1);
        r.push(2);
        expect(r.capacity).toBe(1);
        expect(r.toArray()).toEqual([2]);
        r.clear();
        expect(r.toArray()).toEqual([]);
    });
});

describe('classifyOnData', () => {
    it('只留元数据，绝不留原文（终端里会敲密码/token）', () => {
        const e = classifyOnData('hunter2', 7);
        expect(e).toEqual({ at: 7, len: 7, cjk: false, ctrl: false });
        expect(JSON.stringify(e)).not.toContain('hunter2');
    });

    it('能区分"英文进了、中文没进"（cjk 位是诊断关键）', () => {
        expect(classifyOnData('a', 0).cjk).toBe(false);
        expect(classifyOnData('你好', 0).cjk).toBe(true);
        expect(classifyOnData('ni', 0).cjk).toBe(false); // 拼音阶段还不是 CJK
        expect(classifyOnData('こんにちは', 0).cjk).toBe(true);
        expect(classifyOnData('안녕', 0).cjk).toBe(true);
        expect(classifyOnData('，', 0).cjk).toBe(true); // 全角标点
    });

    it('控制字符可辨（回车 / 方向键 / Ctrl-C）', () => {
        expect(classifyOnData('\r', 0).ctrl).toBe(true);
        expect(classifyOnData(String.fromCharCode(0x1b, 0x5b, 0x41), 0).ctrl).toBe(true);
        expect(classifyOnData(String.fromCharCode(0x03), 0).ctrl).toBe(true);
        expect(classifyOnData('abc', 0).ctrl).toBe(false);
    });
});

describe('installTermDiag', () => {
    it('enabled:false（生产默认）⇒ 不挂全局、noteOnData 是空操作', () => {
        const h = installTermDiag({ enabled: false, read: baseRead });
        h.noteOnData('secret');
        expect(g()).toBeUndefined();
        h.dispose();
    });

    it('enabled:true ⇒ 挂上只读快照，字段是实时 getter', () => {
        let owner = 'nobody';
        const h = installTermDiag({
            enabled: true,
            read: () => ({ ...baseRead(), focusOwner: owner }),
        });
        expect(g().focusOwner).toBe('nobody');
        owner = 'terminal';
        expect(g().focusOwner).toBe('terminal'); // 实时，不是安装时的快照
        expect(g().guardCounters.heals).toBe(1);
        expect(g().lastRestoreAt).toBe(1234);
        h.dispose();
    });

    it('snapshot() 是 frozen 的普通对象（只读，控制台改不动行为）', () => {
        const h = installTermDiag({ enabled: true, read: baseRead });
        const s = g().snapshot();
        expect(Object.isFrozen(s)).toBe(true);
        expect(Object.isFrozen(s.guardCounters)).toBe(true);
        expect(Object.isFrozen(g())).toBe(true);
        expect(s.focusOwner).toBe('nobody');
        h.dispose();
    });

    it('onData 环形缓冲上限 50，只留元数据', () => {
        let now = 0;
        const h = installTermDiag({ enabled: true, read: baseRead, now: () => ++now });
        for (let i = 0; i < 60; i++) h.noteOnData('x');
        const buf = g().recentOnData;
        expect(buf.length).toBe(50);
        expect(buf[0]).toEqual({ at: 11, len: 1, cjk: false, ctrl: false });
        h.dispose();
    });

    it('setOnDataCapture(false) 一键关掉采样并清空已采的', () => {
        const h = installTermDiag({ enabled: true, read: baseRead });
        h.noteOnData('a');
        expect(g().recentOnData.length).toBe(1);
        expect(g().setOnDataCapture(false)).toBe(false);
        expect(g().recentOnData.length).toBe(0);
        h.noteOnData('b');
        expect(g().recentOnData.length).toBe(0);
        expect(g().onDataCapture).toBe(false);
        // 可以再开
        g().setOnDataCapture(true);
        h.noteOnData('c');
        expect(g().recentOnData.length).toBe(1);
        h.dispose();
    });

    it('captureOnData:false 时启用钩子但不采 onData', () => {
        const h = installTermDiag({ enabled: true, captureOnData: false, read: baseRead });
        h.noteOnData('a');
        expect(g().onDataCapture).toBe(false);
        expect(g().recentOnData).toEqual([]);
        h.dispose();
    });

    it('dispose 摘掉自己挂的那个；后挂的实例不会被先挂的 dispose 干掉', () => {
        const first = installTermDiag({ enabled: true, read: baseRead });
        const second = installTermDiag({ enabled: true, read: () => ({ ...baseRead(), focusOwner: 'terminal' }) });
        first.dispose(); // StrictMode 双挂：先挂的清理不许摘掉现役的
        expect(g()).toBeDefined();
        expect(g().focusOwner).toBe('terminal');
        second.dispose();
        expect(g()).toBeUndefined();
    });
});
