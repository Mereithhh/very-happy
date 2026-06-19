/**
 * SessionConsole — the welcome hero's signature element. A small, honest
 * mock of the actual product: a relay-connected coding session, with the one
 * piece of motion on the page (a blinking caret on the "working" line).
 * Grounded in the subject's vernacular — prompt, relay, model, machine, turn.
 */
import * as React from 'react';
import { View, Text, Animated, AccessibilityInfo, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { CYBER } from '@/components/CyberBackdrop';

function Caret() {
    const opacity = React.useRef(new Animated.Value(1)).current;
    React.useEffect(() => {
        let cancelled = false;
        let loop: Animated.CompositeAnimation | null = null;
        const start = () => {
            loop = Animated.loop(
                Animated.sequence([
                    Animated.timing(opacity, { toValue: 0, duration: 560, useNativeDriver: Platform.OS !== 'web' }),
                    Animated.timing(opacity, { toValue: 1, duration: 560, useNativeDriver: Platform.OS !== 'web' }),
                ]),
            );
            loop.start();
        };
        AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
            if (!cancelled && !reduced) start();
        });
        return () => { cancelled = true; loop?.stop(); };
    }, [opacity]);
    return <Animated.Text style={[styles.caret, { opacity }]}>▍</Animated.Text>;
}

export function SessionConsole() {
    return (
        <View style={styles.panel}>
            <View style={styles.bar}>
                <View style={styles.dots}>
                    <View style={[styles.dot, { backgroundColor: '#FF5F57' }]} />
                    <View style={[styles.dot, { backgroundColor: '#FEBC2E' }]} />
                    <View style={[styles.dot, { backgroundColor: '#28C840' }]} />
                </View>
                <Text style={styles.barLabel}>session · iPhone</Text>
            </View>

            <View style={styles.body}>
                <Text style={styles.dim}><Text style={styles.accent}>~ $</Text> very-happy</Text>
                <Text style={styles.line}>
                    <Text style={styles.accent}>✓</Text> relay connected · happy.mereith.com
                </Text>
                <Text style={styles.line}>
                    <Text style={styles.accent}>◆</Text> claude · opus-4.8{'   '}
                    <Text style={styles.dim}>⌁ mac-office</Text>
                </Text>

                <View style={styles.gap} />

                <Text style={styles.line}>
                    <Text style={styles.accent}>›</Text> ship the landing page
                </Text>
                <Text style={styles.line}>
                    <Text style={styles.accent}>●</Text> working <Caret />
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    panel: {
        width: '100%',
        maxWidth: 440,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: CYBER.border,
        backgroundColor: 'rgba(8,11,16,0.72)',
        overflow: 'hidden',
        ...(Platform.OS === 'web' ? ({ boxShadow: '0 24px 70px -30px rgba(0,0,0,0.8)' } as any) : null),
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderBottomWidth: 1,
        borderBottomColor: CYBER.border,
        backgroundColor: 'rgba(255,255,255,0.02)',
    },
    dots: { flexDirection: 'row', gap: 6 },
    dot: { width: 10, height: 10, borderRadius: 5, opacity: 0.9 },
    barLabel: {
        ...Typography.mono(),
        fontSize: 12,
        color: CYBER.textDim,
        letterSpacing: 0.5,
    },
    body: { paddingHorizontal: 16, paddingVertical: 15, gap: 7 },
    line: { ...Typography.mono(), fontSize: 13, lineHeight: 19, color: CYBER.text },
    dim: { ...Typography.mono(), fontSize: 13, lineHeight: 19, color: CYBER.textDim },
    accent: { color: CYBER.accent },
    caret: { ...Typography.mono(), fontSize: 13, color: CYBER.accent },
    gap: { height: 8 },
}));
