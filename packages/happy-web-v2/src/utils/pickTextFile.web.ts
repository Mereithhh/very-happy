/**
 * Pick a text-ish file from the device and read it into a string (web).
 * Native impl lives in pickTextFile.ts. Returns null if the user cancels.
 * Intended for inlining file content into the composer — not for binaries.
 */
import { pickBrowserFile } from './browserFilePicker';

export interface PickedText {
    name: string;
    content: string;
}

export async function pickTextFile(): Promise<PickedText | null> {
    const file = await pickBrowserFile();
    if (!file) return null;
    return { name: file.name || 'file.txt', content: await file.text() };
}
