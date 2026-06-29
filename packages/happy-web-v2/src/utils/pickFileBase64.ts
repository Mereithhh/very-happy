/**
 * Pick any file from the device and read it as base64 (native). Web impl lives
 * in pickFileBase64.web.ts. Returns null if the user cancels. Used to upload a
 * file to the machine (sessionUploadFile) so the agent can read it with its tools.
 */
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';

export interface PickedFile {
    name: string;
    base64: string;
    mimeType?: string;
    isImage: boolean;
}

export async function pickFileBase64(): Promise<PickedFile | null> {
    const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const base64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 });
    return {
        name: asset.name ?? 'file',
        base64,
        mimeType: asset.mimeType,
        isImage: !!asset.mimeType?.startsWith('image/'),
    };
}
