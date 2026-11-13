import { Platform } from 'react-native';
import type { ClientSentFrom } from '@slopus/happy-wire';
import { isRunningOnMac } from '@/utils/platform';

/**
 * Which client sent this message — the same answer for a direct send and a queued prompt (B-509).
 * Typed `ClientSentFrom` (B-924e): a new value does not compile until happy-wire lists it, which makes it
 * the owner's (OWNER_SENT_FROM). `mac` = the app on Mac Catalyst / "Designed for iPad" on a Mac.
 */
export function resolveSentFrom(os: string = Platform.OS, onMac: () => boolean = isRunningOnMac): ClientSentFrom {
    if (os === 'web') return 'web';
    if (os === 'android') return 'android';
    if (os === 'ios') return onMac() ? 'mac' : 'ios';
    return 'web'; // fallback
}
