import * as React from 'react';
import { Text, View, ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, useReducedMotion } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

export type StatusDotKind = 'connected' | 'thinking' | 'permission' | 'offline' | 'failed';

export interface StatusDotProps {
    /** Explicit color. Ignored when `kind` is provided. */
    color?: string;
    /** Explicit pulse. Ignored when `kind` is provided. */
    isPulsing?: boolean;
    size?: number;
    /**
     * Semantic status. When provided, drives color + shape (shape redundancy for
     * WCAG 1.4.1) and takes precedence over `color` / `isPulsing`.
     */
    kind?: StatusDotKind;
    /**
     * a11y label, passed through to the outer View. Callers own the (i18n) text;
     * the component never hardcodes or translates copy.
     */
    accessibilityLabel?: string;
    style?: ViewStyle;
}

interface ResolvedStatus {
    color: string;
    pulsing: boolean;
    hollow: boolean;
    ring: boolean;
    overlay: '!' | '×' | null;
}

export const StatusDot = React.memo(({ color, isPulsing, size = 6, kind, accessibilityLabel, style }: StatusDotProps) => {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();

    const resolved: ResolvedStatus = React.useMemo(() => {
        switch (kind) {
            case 'connected':
                return { color: theme.colors.status.connected, pulsing: false, hollow: false, ring: false, overlay: null };
            case 'thinking':
                return { color: theme.colors.status.connected, pulsing: true, hollow: false, ring: true, overlay: null };
            case 'permission':
                return { color: theme.colors.warning, pulsing: false, hollow: false, ring: false, overlay: '!' };
            case 'offline':
                return { color: theme.colors.textSecondary, pulsing: false, hollow: true, ring: false, overlay: null };
            case 'failed':
                return { color: theme.colors.textDestructive, pulsing: false, hollow: false, ring: false, overlay: '×' };
            default:
                return { color: color ?? theme.colors.status.connected, pulsing: !!isPulsing, hollow: false, ring: false, overlay: null };
        }
    }, [kind, color, isPulsing, theme]);

    // Pulse is suppressed under reduced-motion, but the dot itself stays visible.
    const shouldPulse = resolved.pulsing && !reduceMotion;

    const opacity = useSharedValue(1);

    React.useEffect(() => {
        if (shouldPulse) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1, // infinite
                true // reverse
            );
        } else {
            opacity.value = withTiming(1, { duration: 200 });
        }
    }, [shouldPulse]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    const dotStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: resolved.hollow ? 'transparent' : resolved.color,
        ...(resolved.hollow ? { borderWidth: 1.5, borderColor: resolved.color } : null),
        ...(resolved.ring ? { boxShadow: `0 0 0 2px ${resolved.color}33` } : null),
        alignItems: 'center',
        justifyContent: 'center',
    };

    const overlayStyle: ViewStyle = {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
    };

    return (
        <Animated.View
            accessibilityLabel={accessibilityLabel}
            accessibilityRole={accessibilityLabel ? 'image' : undefined}
            style={[
                dotStyle,
                animatedStyle,
                style,
            ]}
        >
            {resolved.overlay ? (
                <View style={overlayStyle} pointerEvents="none">
                    <Text
                        allowFontScaling={false}
                        style={{
                            fontSize: size * 0.7,
                            lineHeight: size * 0.7,
                            fontWeight: '900',
                            color: theme.colors.groupped.background,
                            textAlign: 'center',
                            includeFontPadding: false,
                        }}
                    >
                        {resolved.overlay}
                    </Text>
                </View>
            ) : null}
        </Animated.View>
    );
});
