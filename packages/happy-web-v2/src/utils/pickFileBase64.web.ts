/**
 * Pick any file from the device and read it as base64 (web). Native impl lives
 * in pickFileBase64.ts. Returns null if the user cancels. Used to upload a file
 * to the machine (sessionUploadFile) so the agent can read it with its tools.
 */
import { pickBrowserFile } from './browserFilePicker';

export interface PickedFile {
    name: string;
    base64: string;
    mimeType?: string;
    isImage: boolean;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export async function pickFileBase64(): Promise<PickedFile | null> {
    const file = await pickBrowserFile();
    if (!file) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = file.type || undefined;
    return {
        name: file.name || 'file',
        base64: bytesToBase64(bytes),
        mimeType,
        isImage: !!mimeType?.startsWith('image/'),
    };
}
