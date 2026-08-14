/**
 * `termInputModel` 的病理序列回归 + 铁律 + 性质测试。
 *
 * spec: `specs/2026-08-terminal-input-ownership.md` §E（核心状态机）与 §可测试性
 * （病理序列表逐行 + 那条覆盖面最大的性质测试）。**每一条病理用例都是一次真实事故的
 * 回归锚**，事故编号见各 describe 的注释。
 *
 * ── 独立 oracle ─────────────────────────────────────────────────────────
 * 断言不只比对字节串，还把 emit 出来的字节**喂进一个模拟 PTY 行缓冲**（`\x7f` 删一个
 * 码点，其余追加），再和「输入域内容 + 已被清空冲走的部分」比对。这条 oracle 不依赖
 * `diffTextValue`，所以 diff 引擎自身写错也会被抓到，而不是自证自明。
 */
import { describe, it, expect } from 'vitest';
import {
    diffTextValue,
    initialState,
    reduce,
    reduceAll,
    toPtyText,
    DEFAULT_FIELD_POLICY,
    type TermInputEvent,
    type TermInputState,
} from './termInputModel';

/** 模拟 PTY 的行缓冲：`\x7f` 删一个码点，其余字符追加。与 diff 引擎完全无关。 */
function applyToPty(pty: string, bytes: string): string {
    const out = [...pty];
    for (const ch of bytes) {
        if (ch === '\x7f') out.pop();
        else out.push(ch);
    }
    return out.join('');
}

const fv = (value: string, at = 0): TermInputEvent => ({ type: 'field-value', value, at });
const start: TermInputEvent = { type: 'composition-start' };
const end: TermInputEvent = { type: 'composition-end' };
const blur: TermInputEvent = { type: 'blur' };
const focus: TermInputEvent = { type: 'focus' };

function run(events: TermInputEvent[], mode: 'clear-on-idle' | 'sticky' = 'clear-on-idle') {
    return reduceAll(initialState(mode), events);
}

// ═══════════════════════════════════════════════════════════════════════════
// 病理序列（spec §可测试性 表，逐行）
// ═══════════════════════════════════════════════════════════════════════════

describe('病理 1：compositionend 缺失（IME 失效 round 1/2 的病根）', () => {
    // xterm 的 `_isComposing` 靠成对的 compositionend 关闭，丢一次就永久 true，
    // 之后所有 229 键被静默吞掉（中文全哑）。这里的模型没有任何这样的闸门。
    it('end 从未到达，后续内容照样一字节不吞', () => {
        const { emit, state } = run([start, fv('ni'), fv('你'), fv('你a')]);
        // 净效果 == 输入域内容；中间的 "ni" 是被观测到的 preedit，提交时由 diff 撤销。
        expect(applyToPty('', emit)).toBe('你a');
        expect(emit).toBe('ni' + '\x7f\x7f你' + 'a');
        // composing 仍然是 true（end 没来），但它没有影响任何一次 emit。
        expect(state.composing).toBe(true);
    });

    it('宿主选择「合成期不观测输入域」时同样一字节不吞', () => {
        // 另一种合法接线：宿主在合成期间不喂 field-value。end 丢失后，下一次
        // 非合成 input 携带的完整 diff 会一次性补齐 —— 因为模型对 composition
        // 事件是无状态的，"错过的观测"不会变成"丢失的字节"。
        const { emit } = run([start, fv('你a')]);
        expect(applyToPty('', emit)).toBe('你a');
    });

    it('连续两个 start、end 迟到、end 重复 —— emit 完全一致', () => {
        const base = [fv('ni'), fv('你'), fv('你a')];
        const canonical = run([start, ...base, end]).emit;
        expect(run([start, start, ...base]).emit).toBe(canonical);
        expect(run([start, ...base, end, end, end]).emit).toBe(canonical);
        expect(run([end, start, ...base]).emit).toBe(canonical);
        expect(run(base).emit).toBe(canonical);
    });
});

describe('病理 2：切输入法中止（Owner 报的「切输入法就打不了中文」）', () => {
    it('start → ni → blur → focus → nia：总量 == 最终内容，无重复提交', () => {
        const { emit, state } = run([start, fv('ni'), blur, focus, fv('nia')]);
        expect(applyToPty('', emit)).toBe('nia');
        expect(state.shadow).toBe('nia');
        // blur 只是让"能否清空"重新可用，不产字节。
        expect(reduce(run([start, fv('ni')]).state, blur).emit).toBe('');
    });
});

describe('病理 3：合成期间失焦', () => {
    it('残留内容恰好提交一次，迟到的 end 不重复发', () => {
        const seq = [start, fv('nihao'), blur];
        const { emit, state } = run(seq);
        expect(emit).toBe('nihao');
        expect(state.composing).toBe(false);
        // 迟到的 compositionend（或它永远不来）都不改变已发字节。
        expect(run([...seq, end]).emit).toBe('nihao');
        expect(run([...seq, end, fv('nihao')]).emit).toBe('nihao');
    });
});

describe('病理 4：快速连打（幂等）', () => {
    it('20 次 field 交错 start/end，含同值重复：拼接 == 最终内容，无双发', () => {
        const events: TermInputEvent[] = [];
        let field = '';
        for (let i = 0; i < 20; i++) {
            field += String.fromCharCode(97 + (i % 26));
            if (i % 3 === 0) events.push(start);
            events.push(fv(field, i));
            events.push(fv(field, i)); // 同值重投（input + compositionend 双触发）
            if (i % 4 === 0) events.push(end);
        }
        const { emit } = run(events, 'sticky');
        expect(applyToPty('', emit)).toBe(field);
        expect(emit).toBe(field); // 纯追加，没有一个多余的 \x7f
    });

    it('同值 field-value 恒 emit 空（幂等的直接断言）', () => {
        const s = run([fv('abc')]).state;
        expect(reduce(s, fv('abc')).emit).toBe('');
        expect(reduce(s, fv('abc')).state.shadow).toBe('abc');
    });
});

describe('病理 5：Gboard 重组合（"删不掉的最后一个字母"）', () => {
    // 退格进已提交的词会让 Gboard 重新组合它；xterm 的 `_compositionPosition.start`
    // 是"合成开始时的长度"快照，重组合算出空子串 ⇒ 退格全被吞掉。
    it('"hello" → start → "hell" 只发一个 \\x7f', () => {
        const { emit } = run([fv('hello'), start, fv('hell')], 'sticky');
        expect(emit).toBe('hello' + '\x7f');
    });

    it('重组合期间连删到空，一个字节都不少', () => {
        const { emit } = run([fv('hello'), start, fv('hell'), fv('hel'), fv('')], 'sticky');
        expect(applyToPty('', emit)).toBe('');
        expect(emit).toBe('hello' + '\x7f'.repeat(5));
    });
});

describe('病理 6：码点 / 代理对', () => {
    it('"a" → "a😀" → "a"：插入整个 emoji，删除只发一个 \\x7f', () => {
        const { emit } = run([fv('a'), fv('a😀'), fv('a')], 'sticky');
        expect(emit).toBe('a' + '😀' + '\x7f');
        expect(applyToPty('', emit)).toBe('a');
    });

    it('共享高位代理时不切开代理对（👍 vs 👎）', () => {
        expect(diffTextValue('a👍', 'a👎')).toEqual({ deletes: 1, insert: '👎' });
        const { emit } = run([fv('a👍'), fv('a👎')], 'sticky');
        expect(applyToPty('', emit)).toBe('a👎');
    });

    it('多字节 CJK 每字一个 \\x7f', () => {
        const { emit } = run([fv('中文字'), fv('中')], 'sticky');
        expect(emit).toBe('中文字' + '\x7f\x7f');
    });
});

describe('病理 7：换行归一', () => {
    it('field("ls\\n") → emit "ls\\r"', () => {
        expect(run([fv('ls\n')]).emit).toBe('ls\r');
        expect(run([fv('ls\r\n')]).emit).toBe('ls\r');
        expect(toPtyText('a\nb\r\nc')).toBe('a\rb\rc');
    });
});

describe('病理 8：清空不发送（adopt 语义）', () => {
    it('clear-on-idle 的 tick 清空：emit 空、shadow 归零、宿主收到 clearField', () => {
        const s = run([fv('ls -la', 1000)]).state;
        const idle = reduce(s, { type: 'tick', now: 1000 + DEFAULT_FIELD_POLICY['clear-on-idle'].clearIdleMs + 1 });
        expect(idle.emit).toBe('');
        expect(idle.clearField).toBe(true);
        expect(idle.state.shadow).toBe('');
    });

    it('未到 idle 阈值 / 合成中 / 已空 —— 都不清', () => {
        const s = run([fv('ls', 1000)]).state;
        expect(reduce(s, { type: 'tick', now: 1200 }).clearField).toBe(false);
        const composing = reduce(s, start).state;
        expect(reduce(composing, { type: 'tick', now: 9999 }).clearField).toBe(false);
        expect(reduce(initialState('clear-on-idle'), { type: 'tick', now: 9999 }).clearField).toBe(false);
    });

    it('sticky 永不因空闲清空（软键盘把字段当自己的模型）', () => {
        const s = run([fv('ls', 1000)], 'sticky').state;
        expect(reduce(s, { type: 'tick', now: 999999 }).clearField).toBe(false);
    });

    it('sticky 只在自然边界 + 超长时收一次，且清空本身不发字节', () => {
        const long = 'x'.repeat(DEFAULT_FIELD_POLICY.sticky.maxLen + 1);
        const noBoundary = reduce(initialState('sticky'), fv(long));
        expect(noBoundary.clearField).toBe(false);
        const boundary = reduce(initialState('sticky'), fv(`${long}\n`));
        expect(boundary.clearField).toBe(true);
        expect(boundary.state.shadow).toBe('');
        // 清空没有额外字节：emit 恰好是这一次 diff 的产物。
        expect(boundary.emit).toBe(toPtyText(`${long}\n`));
    });

    it('adopt 只对齐基准，绝不发送', () => {
        const s = run([fv('ls')]).state;
        const a = reduce(s, { type: 'adopt', value: 'ls -la' });
        expect(a.emit).toBe('');
        expect(a.state.shadow).toBe('ls -la');
        // 对齐之后再观测到同值 ⇒ 依然什么都不发。
        expect(reduce(a.state, fv('ls -la')).emit).toBe('');
    });

    it('clear-request 在合成期被拒绝（清空会打断在途 preedit）', () => {
        const composing = run([fv('ni'), start]).state;
        expect(reduce(composing, { type: 'clear-request' }).clearField).toBe(false);
        const settled = reduce(composing, end).state;
        const cleared = reduce(settled, { type: 'clear-request' });
        expect(cleared.clearField).toBe(true);
        expect(cleared.emit).toBe('');
        expect(cleared.state.shadow).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 铁律：composing 绝不参与「是否 emit」
// ═══════════════════════════════════════════════════════════════════════════

describe('铁律：composition 事件不可能改变任何一个字节', () => {
    const fields = ['n', 'ni', 'nih', '你好', '你好 ', '你好 w'];
    const base = fields.map((v, i) => fv(v, i));

    /** 把 composition/blur/focus 事件按任意方式撒进 base 序列。 */
    function inject(noise: TermInputEvent[], everyN: number): TermInputEvent[] {
        const out: TermInputEvent[] = [];
        base.forEach((e, i) => {
            if (i % everyN === 0) out.push(...noise);
            out.push(e);
        });
        return out;
    }

    const expected = run(base, 'sticky').emit;

    it('无论合成事件怎么缺失 / 重复 / 乱序，emit 恒等', () => {
        const variants: Array<[string, TermInputEvent[]]> = [
            ['规范配对', inject([start, end], 1)],
            ['只有 start（end 全丢）', inject([start], 1)],
            ['只有 end（start 全丢）', inject([end], 1)],
            ['乱序：end 在 start 前', inject([end, start], 1)],
            ['重复：start×3', inject([start, start, start], 2)],
            ['夹 blur/focus', inject([start, blur, focus], 1)],
            ['全是噪声', inject([start, end, end, start, blur, focus, start], 1)],
        ];
        for (const [name, events] of variants) {
            expect(`${name}: ${run(events, 'sticky').emit}`).toBe(`${name}: ${expected}`);
        }
    });

    it('composition/blur/focus 事件自身恒 emit 空、恒不改 shadow', () => {
        const s: TermInputState = run([fv('abc')], 'sticky').state;
        for (const ev of [start, end, blur, focus]) {
            const r = reduce(s, ev);
            expect(r.emit).toBe('');
            expect(r.state.shadow).toBe('abc');
        }
    });

    it('composing 只影响「能否清空」这一件事', () => {
        const typing = run([fv('ls', 0)], 'clear-on-idle').state;
        const composing = reduce(typing, start).state;
        const tick: TermInputEvent = { type: 'tick', now: 5000 };
        // 唯一的差别就在 clearField 上；emit 两边都是空。
        expect(reduce(typing, tick).clearField).toBe(true);
        expect(reduce(composing, tick).clearField).toBe(false);
        expect(reduce(typing, tick).emit).toBe('');
        expect(reduce(composing, tick).emit).toBe('');
        // 同一次输入观测，composing 与否 emit 完全一样。
        expect(reduce(composing, fv('ls -l', 1)).emit).toBe(reduce(typing, fv('ls -l', 1)).emit);
    });

    it('reduce 不改动入参 state（纯函数）', () => {
        const s = initialState('sticky');
        const snapshot = JSON.stringify(s);
        reduce(s, fv('abc'));
        reduce(s, start);
        reduce(s, { type: 'tick', now: 9999 });
        expect(JSON.stringify(s)).toBe(snapshot);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 性质测试（spec §可测试性 点名的那一条，覆盖面最大）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 性质：**给定任意「规范 composition 转写」与任意注入的缺失 / 重复 / 乱序 composition
 * 事件，`emit` 拼接恒等于输入域内容序列的单调增量和。** 通过即等于证明 spec §目标 2。
 *
 * 生成器（确定性伪随机，seed = 1..N，失败可复现 —— 断言消息里带 seed）：
 *  - **编辑算子**：append（ASCII / CJK / emoji / 空格混合字母表）、deleteTail（按码点）、
 *    replaceTail（自动纠错那一类：删 k 个再打一串）、noop（同值重投，测幂等）。
 *  - **规范转写**：随机把连续若干个算子圈成一个「合成段」，段首插 `composition-start`、
 *    段尾插 `composition-end`。这就是"正确"的事件流。
 *  - **注入异常**：对每个 composition 事件独立掷骰 —— 丢弃（模拟 compositionend 缺失）、
 *    重复 2-3 次、与相邻事件交换位置（乱序）；再随机撒入 blur / focus / tick。
 *  - **宿主模拟**：`clearField` 为真时把输入域置空（`committed += field; field = ''`），
 *    与真实宿主的行为一致；这样清空既不发字节，也不会让 oracle 失准。
 *
 * 两条断言：
 *  ① spec 的字面性质：emit 拼接 == 逐次 `diffTextValue` 的单调增量和；
 *  ② **独立 oracle**：把 emit 喂进模拟 PTY 行缓冲后，恒等于 `committed + field`
 *     （不经过 diff 引擎，diff 自身写错也抓得到）。
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 刻意不含 \n：换行归一有专门的用例，而模拟 PTY 里 \r 不是可删除的字符。
const ALPHABET = [...'abcXY 0', '你', '好', '中', '😀', '👍', 'é'];

describe('性质测试：composition 事件的任何异常都不改变 emit', () => {
    const ROUNDS = 300;

    for (const mode of ['sticky', 'clear-on-idle'] as const) {
        it(`${mode}：${ROUNDS} 轮随机算子 × 随机 composition 异常`, () => {
            // 元统计：确保这条性质测试真的在测"异常序列"，而不是空跑规范序列。
            let dropped = 0, duplicated = 0, reordered = 0, cleared = 0;
            for (let seed = 1; seed <= ROUNDS; seed++) {
                const rnd = mulberry32(seed * (mode === 'sticky' ? 1 : 7919));
                const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
                const int = (n: number) => Math.floor(rnd() * n);

                // ── 1. 生成编辑算子，边生成边算出输入域内容序列 ──────────────
                const opCount = 6 + int(20);
                let field = '';
                const values: string[] = [];
                for (let i = 0; i < opCount; i++) {
                    const cps = [...field];
                    const roll = rnd();
                    if (roll < 0.55 || cps.length === 0) {
                        let add = '';
                        for (let k = 0, n = 1 + int(3); k < n; k++) add += pick(ALPHABET);
                        field += add;
                    } else if (roll < 0.8) {
                        field = cps.slice(0, Math.max(0, cps.length - (1 + int(3)))).join('');
                    } else if (roll < 0.95) {
                        const keep = cps.slice(0, Math.max(0, cps.length - (1 + int(3))));
                        let add = '';
                        for (let k = 0, n = 1 + int(3); k < n; k++) add += pick(ALPHABET);
                        field = keep.join('') + add;
                    }
                    // 剩下 5% 是 noop（同值重投）
                    values.push(field);
                }

                // ── 2. 规范转写：把随机连续区间圈成合成段 ─────────────────────
                type Slot = { value: string; pre: TermInputEvent[]; post: TermInputEvent[] };
                const slots: Slot[] = values.map((value) => ({ value, pre: [], post: [] }));
                for (let i = 0; i < slots.length;) {
                    if (rnd() < 0.45) {
                        const len = 1 + int(3);
                        const endIdx = Math.min(slots.length - 1, i + len - 1);
                        slots[i]!.pre.push(start);
                        slots[endIdx]!.post.push(end);
                        i = endIdx + 1;
                    } else {
                        i++;
                    }
                }

                // ── 3. 注入异常：丢弃 / 重复 / 乱序 + blur/focus/tick 噪声 ────
                const events: TermInputEvent[] = [];
                let clock = 0;
                const chaos = (list: TermInputEvent[]) => {
                    const out: TermInputEvent[] = [];
                    for (const ev of list) {
                        const roll = rnd();
                        if (roll < 0.25) { dropped++; continue; }                       // 缺失（compositionend 丢了）
                        if (roll < 0.4) { duplicated++; out.push(ev, ev, ev); continue; } // 重复
                        out.push(ev);
                    }
                    if (out.length > 1 && rnd() < 0.3) { reordered++; out.reverse(); }   // 乱序
                    return out;
                };
                for (const slot of slots) {
                    events.push(...chaos(slot.pre));
                    if (rnd() < 0.2) events.push(rnd() < 0.5 ? blur : focus);
                    clock += 1 + int(50);
                    events.push(fv(slot.value, clock));
                    events.push(...chaos(slot.post));
                    if (rnd() < 0.25) events.push({ type: 'tick', now: clock + int(900) });
                }

                // ── 4. 回放：宿主模拟 clearField；同时算两条参考值 ─────────────
                let state = initialState(mode);
                let emitted = '';
                let expectedFold = '';     // ① spec 字面：单调增量和
                let observed = '';         // 宿主眼里的输入域内容（清空会把它归零）
                let committed = '';        // 被清空冲走的部分（PTY 里仍然在）
                for (const ev of events) {
                    if (ev.type === 'field-value') {
                        const { deletes, insert } = diffTextValue(observed, ev.value);
                        expectedFold += '\x7f'.repeat(deletes) + toPtyText(insert);
                        observed = ev.value;
                    }
                    const r = reduce(state, ev);
                    state = r.state;
                    emitted += r.emit;
                    if (r.clearField) { cleared++; committed += observed; observed = ''; }
                }

                const tag = `mode=${mode} seed=${seed}`;
                expect(`${tag} fold=${JSON.stringify(emitted)}`)
                    .toBe(`${tag} fold=${JSON.stringify(expectedFold)}`);
                expect(`${tag} pty=${JSON.stringify(applyToPty('', emitted))}`)
                    .toBe(`${tag} pty=${JSON.stringify(committed + observed)}`);
            }

            // 生成器没跑空：三类异常都真实发生过（否则这条测试只是在测规范序列）。
            expect({ droppedOk: dropped > 50, dupOk: duplicated > 20, reorderOk: reordered > 10 })
                .toEqual({ droppedOk: true, dupOk: true, reorderOk: true });
            // clear-on-idle 这一档必须真的触发过清空，才算覆盖了「清空不发送」的路径。
            if (mode === 'clear-on-idle') expect(cleared).toBeGreaterThan(10);
        });
    }
});
