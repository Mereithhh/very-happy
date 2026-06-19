/**
 * CyberBackdrop — a full-bleed dark "cyber tech" backdrop for the
 * unauthenticated welcome screen: a deep gradient base, two soft neon glows
 * (cyan + violet) and a faint grid. Pure react-native-svg so it renders
 * identically on web and native, and scales to any viewport.
 */
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Rect, Line } from 'react-native-svg';

export const CYBER = {
    bg0: '#06080F',
    bg1: '#0A0E1A',
    cyan: '#22D3EE',
    violet: '#7C5CFF',
    text: '#EAF0FF',
    textDim: '#8A93A6',
    line: 'rgba(120,160,220,0.06)',
    cardBg: 'rgba(255,255,255,0.035)',
    cardBorder: 'rgba(120,200,255,0.16)',
};

export function CyberBackdrop() {
    const { width, height } = useWindowDimensions();
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    const step = 44; // grid cell
    const cols = Math.ceil(w / step);
    const rows = Math.ceil(h / step);

    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
            <Svg width={w} height={h}>
                <Defs>
                    <LinearGradient id="cyberBase" x1="0" y1="0" x2="0" y2="1">
                        <Stop offset="0" stopColor={CYBER.bg1} />
                        <Stop offset="1" stopColor={CYBER.bg0} />
                    </LinearGradient>
                    <RadialGradient id="glowCyan" cx="20%" cy="12%" r="55%">
                        <Stop offset="0" stopColor={CYBER.cyan} stopOpacity="0.22" />
                        <Stop offset="1" stopColor={CYBER.cyan} stopOpacity="0" />
                    </RadialGradient>
                    <RadialGradient id="glowViolet" cx="88%" cy="92%" r="60%">
                        <Stop offset="0" stopColor={CYBER.violet} stopOpacity="0.26" />
                        <Stop offset="1" stopColor={CYBER.violet} stopOpacity="0" />
                    </RadialGradient>
                </Defs>

                <Rect x="0" y="0" width={w} height={h} fill="url(#cyberBase)" />

                {/* faint grid */}
                {Array.from({ length: cols + 1 }).map((_, i) => (
                    <Line key={`v${i}`} x1={i * step} y1={0} x2={i * step} y2={h} stroke={CYBER.line} strokeWidth={1} />
                ))}
                {Array.from({ length: rows + 1 }).map((_, i) => (
                    <Line key={`h${i}`} x1={0} y1={i * step} x2={w} y2={i * step} stroke={CYBER.line} strokeWidth={1} />
                ))}

                {/* neon glows on top of the grid */}
                <Rect x="0" y="0" width={w} height={h} fill="url(#glowCyan)" />
                <Rect x="0" y="0" width={w} height={h} fill="url(#glowViolet)" />
            </Svg>
        </View>
    );
}
