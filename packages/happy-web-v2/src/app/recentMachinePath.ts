import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { pushRecentMachinePath } from '@/utils/quickChat';

/** Remember a successful machine+directory so the next quick create reuses it. */
export function recordRecentMachinePath(machineId: string, path: string): void {
    const current = storage.getState().settings.recentMachinePaths ?? [];
    sync.applySettings({ recentMachinePaths: pushRecentMachinePath(current, { machineId, path }) });
}
