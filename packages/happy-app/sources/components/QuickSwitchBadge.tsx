/**
 * Small mono number badge (1–9) shown on a session row while Cmd/Meta is held,
 * indicating which ⌘<n> jumps to that session. Web-only affordance; renders
 * nothing on native or when the session has no quick-switch number.
 */
import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const QuickSwitchBadge = React.memo(({ number }: { number: number }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.badge}>
            <Text style={[styles.badgeText, { color: theme.colors.button.primary.tint }]}>
                {number}
            </Text>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: 4,
        borderRadius: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
        marginLeft: 8,
        flexShrink: 0,
    },
    badgeText: {
        fontSize: 11,
        lineHeight: 14,
        ...Typography.mono('semiBold'),
    },
}));
