/**
 * CyberMark — the very-happy smiley rendered as SVG with a neon glow, for the
 * cyber welcome hero. Glow is a web box-shadow (no-op on native, which just
 * shows the clean mark).
 */
import * as React from 'react';
import { View, Platform } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { CYBER } from './CyberBackdrop';

export function CyberMark({ size = 72 }: { size?: number }) {
    return (
        <View
            style={[
                { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
                Platform.OS === 'web'
                    ? ({ filter: `drop-shadow(0 0 18px ${CYBER.cyan}aa)` } as any)
                    : null,
            ]}
        >
            <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
                <Circle cx="35.5" cy="40" r="7.5" fill={CYBER.cyan} />
                <Circle cx="64.5" cy="40" r="7.5" fill={CYBER.cyan} />
                <Path d="M28 52 Q50 80 72 52" stroke={CYBER.cyan} strokeWidth={9} strokeLinecap="round" />
            </Svg>
        </View>
    );
}
