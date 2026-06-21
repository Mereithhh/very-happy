/**
 * EmptyDetailPane — shown in the detail area on wide screens when sessions
 * exist but none is selected (the index route). Replaces a blank white pane
 * with a calm, branded "pick a conversation" state + a new-session CTA.
 */
import React from 'react';
import { View, Text, Pressable, Image, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 48,
        backgroundColor: theme.colors.surface,
    },
    logo: {
        width: 52,
        height: 52,
        opacity: 0.5,
        marginBottom: 22,
    },
    title: {
        fontSize: 19,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    description: {
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 26,
        maxWidth: 340,
        ...Typography.default(),
    },
    button: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 22,
        paddingVertical: 12,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    buttonText: {
        fontSize: 15,
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
    secondary: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        marginTop: 14,
        paddingVertical: 8,
        paddingHorizontal: 14,
    },
    secondaryText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export function EmptyDetailPane() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();

    return (
        <View style={styles.container}>
            <Image
                source={require('@/assets/images/logo-black.png')}
                tintColor={theme.colors.textSecondary}
                style={styles.logo}
                resizeMode="contain"
            />
            <Text style={styles.title}>Pick up where you left off · 继续上次的工作</Text>
            <Text style={styles.description}>
                Select a conversation on the left, or start a new one on any connected machine.{'\n'}在左侧选择一个会话，或在任意已连接的机器上新建一个。
            </Text>
            <Pressable style={({ pressed }) => [styles.button, { opacity: pressed ? 0.85 : 1 }]} onPress={() => router.navigate('/new')}>
                <Ionicons name="add" size={19} color={theme.colors.button.primary.tint} />
                <Text style={styles.buttonText}>New session · 新建会话</Text>
            </Pressable>
            {Platform.OS === 'web' && (
                <Pressable
                    style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.7 : 1 }]}
                    onPress={() => router.navigate('/terminal/web' as any)}
                >
                    <Ionicons name="terminal-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={styles.secondaryText}>Open web terminal · 打开网页终端</Text>
                </Pressable>
            )}
        </View>
    );
}
