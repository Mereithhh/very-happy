declare module 'expo-audio' {
    export const AudioModule: {
        requestRecordingPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean }>;
        getRecordingPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean }>;
        setAudioModeAsync(options: Record<string, unknown>): Promise<void>;
    };
}

declare module 'expo-clipboard' {
    export function setStringAsync(value: string): Promise<void>;
}

declare module 'expo-router' {
    export function useSegments(): string[];
}

declare module 'expo-sharing' {
    export function isAvailableAsync(): Promise<boolean>;
    export function shareAsync(uri: string, options?: Record<string, unknown>): Promise<void>;
}

declare module 'expo-store-review' {
    export function isAvailableAsync(): Promise<boolean>;
    export function requestReview(): Promise<void>;
}

declare module '@tauri-apps/plugin-opener' {
    export function openUrl(url: string): Promise<void>;
}
