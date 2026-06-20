import * as React from 'react';
import { View, Text } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';

// Native fallback — the web terminal is web-only (xterm.js / DOM).
export default function WebTerminalScreenNative() {
    const { theme } = useUnistyles();
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: theme.colors.surface }}>
            <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>
                The web terminal is available in the browser.
            </Text>
        </View>
    );
}
