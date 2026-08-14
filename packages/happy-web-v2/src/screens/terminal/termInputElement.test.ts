/**
 * 「谁是终端输入元素」的唯一判据 —— 以及它确实被四个调用点共用的结构断言。
 * 这条判据散成四份 hardcode class 名，就是 B-093 那类事故的下一次复发。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    isTerminalInputElement,
    TERM_INPUT_CLASS,
    XTERM_HELPER_CLASS,
    TERM_INPUT_SELECTOR,
} from './termInputElement';

const el = (...classes: string[]) => ({
    classList: { contains: (n: string) => classes.includes(n) },
});

describe('isTerminalInputElement', () => {
    it('旧路径：xterm 的 helper textarea', () => {
        expect(isTerminalInputElement(el(XTERM_HELPER_CLASS))).toBe(true);
    });

    it('新路径：我们自有的 overlay', () => {
        expect(isTerminalInputElement(el(TERM_INPUT_CLASS))).toBe(true);
    });

    it('其它元素一律 false', () => {
        expect(isTerminalInputElement(el('some-input'))).toBe(false);
        expect(isTerminalInputElement(el())).toBe(false);
    });

    it('null / undefined / 无 classList 的对象不炸（跨 realm、老浏览器）', () => {
        expect(isTerminalInputElement(null)).toBe(false);
        expect(isTerminalInputElement(undefined)).toBe(false);
        expect(isTerminalInputElement({})).toBe(false);
        expect(isTerminalInputElement({ classList: {} })).toBe(false);
        expect(isTerminalInputElement('body')).toBe(false);
    });

    it('选择器覆盖两条路径', () => {
        expect(TERM_INPUT_SELECTOR).toBe(`.${TERM_INPUT_CLASS},.${XTERM_HELPER_CLASS}`);
    });
});

describe('结构：判据只有一份实现，四个调用点都走它', () => {
    const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

    it('本模块零 import（closeGuard 必须能在 node 环境里 import 它）', () => {
        const src = read('./termInputElement.ts');
        expect((src.match(/^\s*import[\s{]/gm) ?? []).length).toBe(0);
    });

    it('closeGuard / viewShortcuts / Menu / termFocusOwnership 都不再 hardcode class 名', () => {
        const callers: Array<[string, string]> = [
            ['closeGuard.ts', read('../../app/closeGuard.ts')],
            ['viewShortcuts.ts', read('../../app/viewShortcuts.ts')],
            ['Menu.tsx', read('../../ui/Menu.tsx')],
            ['termFocusOwnership.ts', read('./termFocusOwnership.ts')],
        ];
        for (const [name, src] of callers) {
            expect(`${name}: ${src.includes(`'${XTERM_HELPER_CLASS}'`)}`).toBe(`${name}: false`);
            expect(`${name}: ${src.includes('termInputElement')}`).toBe(`${name}: true`);
        }
    });
});
