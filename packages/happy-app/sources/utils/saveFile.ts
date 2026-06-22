/**
 * Save raw file bytes to the user's device (native iOS/Android).
 *
 * Stages the bytes to a temp file in cacheDirectory, then hands it to the OS
 * share sheet (which offers "Save to Files", AirDrop, etc). The web impl lives
 * in saveFile.web.ts — Metro picks the right one per platform. Input bytes are
 * base64 (as returned by sessionReadFile), so this works for text AND binary.
 */
import { writeAsStringAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { randomUUID } from 'expo-crypto';

export interface SaveFileInput {
    /** suggested file name (path tail is used) */
    filename: string;
    /** raw file bytes, base64-encoded */
    base64: string;
    mimeType?: string;
}

export async function saveFile({ filename, base64, mimeType }: SaveFileInput): Promise<void> {
    if (!cacheDirectory) {
        throw new Error('cacheDirectory unavailable on this platform');
    }
    const safe = (filename.split('/').pop() || 'download').replace(/[^\w.\-]+/g, '_');
    const uri = `${cacheDirectory}${randomUUID()}-${safe}`;
    await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
    if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, mimeType ? { mimeType } : undefined);
    }
}
