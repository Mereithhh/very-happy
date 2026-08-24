import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({
  machineUploadFile: vi.fn(),
  machineUploadFileChunk: vi.fn(),
}));

import {
  TERMINAL_UPLOAD_CHUNK_BYTES,
  TERMINAL_UPLOAD_MAX_BYTES,
  quoteTerminalUploadPath,
  terminalUploadName,
  uploadTerminalFile,
  type TerminalUploadRpc,
} from './terminalFileUpload';

function fileOf(size: number, name = 'screen.png'): File {
  return new File([new Uint8Array(size).fill(0x61)], name, { type: 'image/png' });
}

function rpcMock(): TerminalUploadRpc & { chunk: ReturnType<typeof vi.fn>; legacy: ReturnType<typeof vi.fn> } {
  return {
    chunk: vi.fn(async (_machineId, request) => {
      if (request.action === 'finish') return { success: true, path: '/home/u/.happy/uploads/terminal/screen.png', size: 1 };
      return { success: true };
    }),
    legacy: vi.fn(async () => ({ success: true, path: '/legacy/screen.png' })),
  };
}

describe('terminal file upload', () => {
  it('chunks files below the encrypted relay payload limit and reports progress', async () => {
    const rpc = rpcMock();
    const progress = vi.fn();
    const file = fileOf(TERMINAL_UPLOAD_CHUNK_BYTES * 2 + 7);
    const result = await uploadTerminalFile('m1', file, { rpc, onProgress: progress, createUploadId: () => 'upload_test_1234' });

    expect(result).toMatchObject({ success: true, path: expect.stringContaining('screen.png') });
    expect(rpc.chunk.mock.calls.map((call) => call[1].action)).toEqual(['start', 'append', 'append', 'append', 'finish']);
    expect(rpc.chunk.mock.calls.filter((call) => call[1].action === 'append').map((call) => call[1].offset)).toEqual([0, TERMINAL_UPLOAD_CHUNK_BYTES, TERMINAL_UPLOAD_CHUNK_BYTES * 2]);
    expect(progress).toHaveBeenLastCalledWith(file.size, file.size);
    expect(rpc.legacy).not.toHaveBeenCalled();
  });

  it('keeps a small-file fallback for old daemons', async () => {
    const rpc = rpcMock();
    rpc.chunk.mockResolvedValueOnce({ success: false, error: 'Method not found' });
    const result = await uploadTerminalFile('m1', fileOf(16), { rpc, createUploadId: () => 'upload_test_1234' });
    expect(result).toEqual({ success: true, path: '/legacy/screen.png' });
    expect(rpc.legacy).toHaveBeenCalledOnce();
  });

  it('does not let a new-daemon failure bypass chunk validation through legacy upload', async () => {
    const rpc = rpcMock();
    rpc.chunk.mockResolvedValueOnce({ success: false, error: 'Too many active uploads' });
    const result = await uploadTerminalFile('m1', fileOf(16), { rpc, createUploadId: () => 'upload_test_1234' });
    expect(result).toEqual({ success: false, error: 'Too many active uploads' });
    expect(rpc.legacy).not.toHaveBeenCalled();
  });

  it('rejects oversized files before sending and asks old daemons to update for larger files', async () => {
    const rpc = rpcMock();
    expect(await uploadTerminalFile('m1', fileOf(TERMINAL_UPLOAD_MAX_BYTES + 1), { rpc })).toMatchObject({ success: false, error: expect.stringContaining('8 MB') });
    expect(rpc.chunk).not.toHaveBeenCalled();

    rpc.chunk.mockResolvedValueOnce({ success: false, error: 'Method not found' });
    expect(await uploadTerminalFile('m1', fileOf(TERMINAL_UPLOAD_CHUNK_BYTES * 2), { rpc, createUploadId: () => 'upload_test_1234' })).toMatchObject({ success: false, error: expect.stringContaining('newer Very Happy daemon') });
    expect(rpc.legacy).not.toHaveBeenCalled();
  });

  it('aborts an incomplete upload and creates collision-resistant display names', async () => {
    const rpc = rpcMock();
    rpc.chunk
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'network' })
      .mockResolvedValueOnce({ success: true });
    expect(await uploadTerminalFile('m1', fileOf(32), { rpc, createUploadId: () => 'upload_test_1234' })).toEqual({ success: false, error: 'network' });
    expect(rpc.chunk.mock.calls.at(-1)?.[1]).toEqual({ action: 'abort', uploadId: 'upload_test_1234' });
    expect(terminalUploadName('shot.png', 123)).toBe('drop-3f-shot.png');
  });

  it('quotes the complete daemon path as one shell token and rejects control characters', () => {
    expect(quoteTerminalUploadPath("/Users/o'neil/.happy/uploads/a.png")).toBe("'/Users/o'\\''neil/.happy/uploads/a.png'");
    expect(quoteTerminalUploadPath("C:\\Users\\O'Neil\\a.png", 'powershell')).toBe("'C:\\Users\\O''Neil\\a.png'");
    expect(quoteTerminalUploadPath('C:\\Users\\Jo Jo\\a.png', 'cmd')).toBe('"C:\\Users\\Jo Jo\\a.png"');
    expect(quoteTerminalUploadPath('C:\\Users\\%USERNAME%\\a.png', 'cmd')).toBeNull();
    expect(quoteTerminalUploadPath('C:\\Users\\Jo\\a.png', 'unknown')).toBeNull();
    expect(quoteTerminalUploadPath('/tmp/line\nbreak')).toBeNull();
    expect(quoteTerminalUploadPath('')).toBeNull();
  });
});
