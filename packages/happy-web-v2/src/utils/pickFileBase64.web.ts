/**
 * Pick any file from the device and read it as base64 (web). Native impl lives
 * in pickFileBase64.ts. Returns null if the user cancels. Used to upload a file
 * to the machine (sessionUploadFile) so the agent can read it with its tools.
 */
import * as DocumentPicker from 'expo-document-picker';

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
    const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false,
        multiple: false,
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const file: File | undefined = (asset as any).file;
    let bytes: Uint8Array;
    let mimeType = asset.mimeType;
    if (file) {
        bytes = new Uint8Array(await file.arrayBuffer());
        mimeType = mimeType || file.type;
    } else {
        const r = await fetch(asset.uri);
        bytes = new Uint8Array(await r.arrayBuffer());
    }
    return {
        name: asset.name ?? 'file',
        base64: bytesToBase64(bytes),
        mimeType,
        isImage: !!mimeType?.startsWith('image/'),
    };
}
