/**
 * CyberBackdrop — the dark "control-room" backdrop for the welcome screen:
 * a deep ink gradient, a fine technical grid, one restrained teal glow up top,
 * and a vignette that focuses attention on the hero. Pure react-native-svg so
 * it renders identically on web and native and scales to any viewport.
 *
 * One disciplined accent (teal-mint "live" signal) — no dual-neon gradient.
 */
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Rect, Line } from 'react-native-svg';

export const CYBER = {
    bg0: '#080A0E',
    bg1: '#0D1119',
    accent: '#34E2C4',          // teal-mint "live/connected" signal
    accentText: '#04110E',      // ink for text on the accent fill
    accentDim: 'rgba(52,226,196,0.14)',
    text: '#E8EDF4',
    textDim: '#7C8696',
    line: 'rgba(122,162,214,0.055)',
    panel: 'rgba(255,255,255,0.022)',
    border: 'rgba(130,170,210,0.13)',
};

export function CyberBackdrop() {
    const { width, height } = useWindowDimensions();
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    const step = 46;
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
                    <RadialGradient id="cyberGlow" cx="50%" cy="-2%" r="62%">
                        <Stop offset="0" stopColor={CYBER.accent} stopOpacity="0.16" />
                        <Stop offset="1" stopColor={CYBER.accent} stopOpacity="0" />
                    </RadialGradient>
                    <RadialGradient id="cyberVignette" cx="50%" cy="42%" r="75%">
                        <Stop offset="0.55" stopColor="#000000" stopOpacity="0" />
                        <Stop offset="1" stopColor="#000000" stopOpacity="0.55" />
                    </RadialGradient>
                </Defs>

                <Rect x="0" y="0" width={w} height={h} fill="url(#cyberBase)" />

                {/* fine technical grid */}
                {Array.from({ length: cols + 1 }).map((_, i) => (
                    <Line key={`v${i}`} x1={i * step} y1={0} x2={i * step} y2={h} stroke={CYBER.line} strokeWidth={1} />
                ))}
                {Array.from({ length: rows + 1 }).map((_, i) => (
                    <Line key={`h${i}`} x1={0} y1={i * step} x2={w} y2={i * step} stroke={CYBER.line} strokeWidth={1} />
                ))}

                <Rect x="0" y="0" width={w} height={h} fill="url(#cyberGlow)" />
                <Rect x="0" y="0" width={w} height={h} fill="url(#cyberVignette)" />
            </Svg>
        </View>
    );
}
