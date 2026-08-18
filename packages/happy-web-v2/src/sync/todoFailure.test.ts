/**
 * B-007 / B-003 回归：daemon 侧抛的错必须被映射成有意义的 code。
 *
 * 为什么值得单测：RpcHandlerManager 把 handler 抛的错编码成 `{error}` 的**正常
 * 响应**（B-003 坑），映射错了不会崩、只会在界面上显示 "unknown error" —— 用户被
 * 锁在门外却没有任何线索。这类 bug 只有测试能发现。
 */
import { describe, expect, it } from 'vitest';
import { todoFailureOf } from './todoFailure';

describe('todoFailureOf', () => {
    it('旧 daemon / 机器离线 → unsupported（relay 对两者的回答一样，无法区分）', () => {
        expect(todoFailureOf('RPC method not available').code).toBe('unsupported');
        expect(todoFailureOf('Method not found').code).toBe('unsupported');
    });

    it('未配置 provider → not-configured（这是「功能没开」不是错误）', () => {
        expect(todoFailureOf('not-configured').code).toBe('not-configured');
    });

    it('provider 非零退出 → 保留它的 stderr 作为详情（显示 unknown error 等于把人锁在门外）', () => {
        const f = todoFailureOf('provider-error: permission denied for project X');
        expect(f.code).toBe('provider-error');
        expect(f.error).toBe('permission denied for project X');
    });

    it('带前缀但无详情时不吃掉原文', () => {
        expect(todoFailureOf('provider-error:').error).toBe('provider-error:');
    });

    it('超时与坏输出各有专属 code', () => {
        expect(todoFailureOf('timeout').code).toBe('timeout');
        expect(todoFailureOf('bad-output: provider did not output JSON: <html>').code).toBe('bad-output');
        expect(todoFailureOf('bad-output: provider did not output JSON: <html>').error).toContain('<html>');
    });

    it('认不出的错误落到 unknown 但保留原文', () => {
        expect(todoFailureOf('something weird')).toEqual({ ok: false, code: 'unknown', error: 'something weird' });
    });

    it('不把只是「包含」关键词的错误误判（必须是前缀）', () => {
        expect(todoFailureOf('the timeout was fine, but disk failed').code).toBe('unknown');
    });
});
