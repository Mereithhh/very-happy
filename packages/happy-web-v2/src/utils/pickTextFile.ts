/**
 * Pick a text-ish file from the device and read it into a string (native).
 * Web impl lives in pickTextFile.web.ts. Returns null if the user cancels.
 * Intended for inlining file content into the composer — not for binaries.
 */
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';

export interface PickedText {
    name: string;
    content: string;
}

export async function pickTextFile(): Promise<PickedText | null> {
    const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const content = await readAsStringAsync(asset.uri, { encoding: EncodingType.UTF8 });
    return { name: asset.name ?? 'file.txt', content };
}
