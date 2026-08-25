import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_KILL_DEADLINE_MS, commitSessionArchive } from './sessionArchiveFlow';

afterEach(() => {
  vi.useRealTimers();
});

describe('commitSessionArchive', () => {
  it('commits the server archive even when kill acknowledges success', async () => {
    const kill = vi.fn().mockResolvedValue({ success: true });
    const archive = vi.fn().mockResolvedValue({ success: true });

    await commitSessionArchive(kill, archive);

    expect(kill).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(archive.mock.invocationCallOrder[0]);
  });

  it('still archives an already-dead or unreachable session', async () => {
    const archive = vi.fn().mockResolvedValue({ success: true });
    await expect(commitSessionArchive(
      vi.fn().mockRejectedValue(new Error('RPC unavailable')),
      archive,
    )).resolves.toBeUndefined();
    expect(archive).toHaveBeenCalledOnce();
  });

  it('does not let a missing kill acknowledgement block the relay archive', async () => {
    vi.useFakeTimers();
    const archive = vi.fn().mockResolvedValue({ success: true });
    const pendingKill = new Promise<{ success: boolean }>(() => {});

    const committed = commitSessionArchive(
      vi.fn(() => pendingKill),
      archive,
    );

    await vi.advanceTimersByTimeAsync(ARCHIVE_KILL_DEADLINE_MS - 1);
    expect(archive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(committed).resolves.toBeUndefined();
    expect(archive).toHaveBeenCalledOnce();
  });

  it('fails closed when the relay does not confirm the inactive state', async () => {
    await expect(commitSessionArchive(
      vi.fn().mockResolvedValue({ success: true }),
      vi.fn().mockResolvedValue({ success: false, message: 'relay rejected archive' }),
    )).rejects.toThrow('relay rejected archive');
  });
});
