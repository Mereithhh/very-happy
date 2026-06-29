/**
 * web shim for expo-notifications. Native/Expo push and local scheduled
 * notifications are not used on web — web push is handled separately via the
 * VAPID path (sync/webPush.ts) and the service worker. These are no-ops returning
 * sensible defaults so the data layer compiles and runs.
 */
export enum SchedulableTriggerInputTypes {
  TIME_INTERVAL = 'timeInterval',
  DATE = 'date',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  CALENDAR = 'calendar',
}

interface PermissionResponse {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
}

function denied(): PermissionResponse {
  return { status: 'undetermined', granted: false, canAskAgain: true };
}

export async function getPermissionsAsync(): Promise<PermissionResponse> {
  return denied();
}

export async function requestPermissionsAsync(): Promise<PermissionResponse> {
  return denied();
}

export async function getExpoPushTokenAsync(_opts?: {
  projectId?: string;
}): Promise<{ data: string; type: string }> {
  // No Expo push token on web; web push uses a PushSubscription instead.
  return { data: '', type: 'expo' };
}

export async function scheduleNotificationAsync(_request: unknown): Promise<string> {
  return '';
}

export async function cancelScheduledNotificationAsync(_id: string): Promise<void> {}

export function setNotificationHandler(_handler: unknown): void {}
