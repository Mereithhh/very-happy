import { it, expect, vi } from 'vitest';
import { serialTask } from './serialTask';
it('releases the heartbeat guard after a hold and an exception', async()=>{
 const task=vi.fn(async()=>{}); const tick=serialTask(task);
 await tick(); await tick(); expect(task).toHaveBeenCalledTimes(2);
 task.mockRejectedValueOnce(new Error('probe failed')); await expect(tick()).rejects.toThrow();
 await tick(); expect(task).toHaveBeenCalledTimes(4);
});
it('does not run two overlapping heartbeat probes',async()=>{
 let finish!:()=>void;
 const task=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})); const tick=serialTask(task);
 const first=tick(); await tick(); expect(task).toHaveBeenCalledTimes(1); finish(); await first;
});
