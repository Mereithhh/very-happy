import { describe, expect, it, vi } from 'vitest';
import { commitSessionArchive } from './sessionArchiveFlow';

describe('commitSessionArchive', () => {
  it('commits the server-owned archive transition exactly once', async () => {
    const archive = vi.fn().mockResolvedValue({ success: true });
    await commitSessionArchive(archive);
    expect(archive).toHaveBeenCalledOnce();
  });

  it('fails closed when the relay does not confirm the inactive state', async () => {
    await expect(commitSessionArchive(
      vi.fn().mockResolvedValue({ success: false, message: 'relay rejected archive' }),
    )).rejects.toThrow('relay rejected archive');
  });
});
