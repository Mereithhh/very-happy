/**
 * B-138 回归：RPC 超时必须映射成 'timeout' 失败态，而不是永久 pending 或 'unknown'。
 *
 * 修之前 `machineRPC` / `sessionRPC` 用的是**裸 `emitWithAck`（无 timeout）**，
 * server 不应答就永久挂起——UI 一直转圈。这条测的是「超时被识别并有专属 code」，
 * 因为那是用户能看到差别的地方（'unknown' 会把原始错误串糊到界面上）。
 */
import { describe, expect, it } from 'vitest';
import { isTimeoutError } from './rpcTimeout';

describe('isTimeoutError', () => {
    it('认得 socket.io 的超时错误', () => {
        // socket.io 客户端 .timeout() 超时时 reject 的就是这个形状
        expect(isTimeoutError(new Error('operation has timed out'))).toBe(true);
        expect(isTimeoutError(new Error('timeout'))).toBe(true);
        expect(isTimeoutError(new Error('Timed out'))).toBe(true);
        expect(isTimeoutError('timed out')).toBe(true);
    });

    it('不把普通失败误判成超时', () => {
        for (const e of [
            new Error('RPC method not available'),
            new Error('not-found'),
            new Error('Machine encryption not found for m1'),
            new Error(''),
            null,
            undefined,
        ]) {
            expect(isTimeoutError(e), String(e)).toBe(false);
        }
    });
});
