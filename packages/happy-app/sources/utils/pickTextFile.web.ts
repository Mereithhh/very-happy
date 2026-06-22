/**
 * Pick a text-ish file from the device and read it into a string (web).
 * Native impl lives in pickTextFile.ts. Returns null if the user cancels.
 * Intended for inlining file content into the composer — not for binaries.
 */
import * as DocumentPicker from 'expo-document-picker';

export interface PickedText {
    name: string;
    content: string;
}

export async function pickTextFile(): Promise<PickedText | null> {
    const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false,
        multiple: false,
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const file: File | undefined = (asset as any).file;
    let content: string;
    if (file) {
        content = await file.text();
    } else {
        const r = await fetch(asset.uri);
        content = await r.text();
    }
    return { name: asset.name ?? 'file.txt', content };
}
