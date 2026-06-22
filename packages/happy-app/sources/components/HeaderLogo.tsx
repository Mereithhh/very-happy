import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

/**
 * Shared header logo component used across all main tabs.
 * Extracted to prevent flickering on tab switches - when each tab
 * had its own HeaderLeft, the component would unmount/remount.
 *
 * When `onPress` is supplied (mobile header) the logo becomes a tappable
 * "go home" affordance — tapping it returns to the sessions list.
 */
export const HeaderLogo = React.memo(({ onPress }: { onPress?: () => void }) => {
    const { theme } = useUnistyles();
    const boxStyle = {
        width: 32,
        height: 32,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    };
    const logo = (
        <Image
            source={require('@/assets/images/logo-black.png')}
            contentFit="contain"
            style={{ width: 24, height: 24 }}
            tintColor={theme.colors.header.tint}
        />
    );
    if (onPress) {
        return (
            <Pressable
                onPress={onPress}
                hitSlop={10}
                accessibilityRole="button"
                style={({ pressed }) => [boxStyle, { opacity: pressed ? 0.6 : 1 }]}
            >
                {logo}
            </Pressable>
        );
    }
    return <View style={boxStyle}>{logo}</View>;
});
