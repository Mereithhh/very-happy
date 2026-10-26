import { Platform } from 'react-native';
import Constants from 'expo-constants';

export function getHappyClientId(): string {
    let platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    if (platform === 'web' && typeof window !== 'undefined' && '__TAURI__' in window) {
        platform = 'desktop';
    }
    const version = Constants.expoConfig?.version || '0.0.0';
    return `${platform}/${version}`;
}
