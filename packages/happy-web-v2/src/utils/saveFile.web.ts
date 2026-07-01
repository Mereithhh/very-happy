/**
 * Save raw file bytes to the user's device.
 *
 * Web impl: build a Blob and trigger an <a download>. The native impl
 * (expo-file-system + expo-sharing) lives in saveFile.ts — Metro picks the
 * right one per platform. Input bytes are base64 (as returned by
 * sessionReadFile), so this works for text AND binary files.
 */
export interface SaveFileInput {
    /** suggested file name (path tail is used) */
    filename: string;
    /** raw file bytes, base64-encoded */
    base64: string;
    mimeType?: string;
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export async function saveFile({ filename, base64, mimeType }: SaveFileInput): Promise<void> {
    const bytes = base64ToBytes(base64);
    const blob = new Blob([bytes as unknown as BlobPart], mimeType ? { type: mimeType } : {});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.split('/').pop() || filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
