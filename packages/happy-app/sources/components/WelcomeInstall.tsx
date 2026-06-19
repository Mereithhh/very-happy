/**
 * WelcomeInstall — the landing block shown on the unauthenticated welcome
 * screen (web only).
 *
 * Tells the very-happy story (a friendly fork of Happy, with what it adds),
 * then explains how to get going on your computer in three steps: install
 * Claude Code, install the very-happy CLI from npm (pre-configured to this
 * server), run it. Closes with an honest server-trusted disclosure.
 */

import * as React from 'react';
import { View, Text, Pressable, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

const CLI_INSTALL = 'npm i -g very-happy-cli';
const CLI_RUN = 'very-happy';
const REPO_URL = 'https://github.com/Mereithhh/very-happy';
const UPSTREAM_URL = 'https://github.com/slopus/happy';

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
    { icon: 'key-outline', text: 'Password sign-in — no QR pairing, on any device' },
    { icon: 'sync-outline', text: 'Multi-device sync — your sessions follow you' },
    { icon: 'notifications-outline', text: 'Web push when your agent needs you' },
    { icon: 'sparkles-outline', text: 'Reworked Claude Code UI + the latest models' },
];

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 460,
        marginTop: 36,
        paddingHorizontal: 20,
        paddingVertical: 20,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    introTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        marginBottom: 6,
    },
    introText: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    link: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    features: {
        marginTop: 14,
        gap: 9,
    },
    featureRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
    },
    featureText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default(),
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginVertical: 18,
    },
    heading: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        marginBottom: 14,
    },
    step: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 12,
    },
    stepNum: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.groupped.background,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    stepNumText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    stepBody: {
        flex: 1,
    },
    stepText: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
        ...Typography.default(),
    },
    cmdRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 6,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.groupped.background,
    },
    cmd: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    note: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 8,
        paddingTop: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    noteText: {
        flex: 1,
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

function CommandRow({ cmd }: { cmd: string }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);

    const copy = React.useCallback(() => {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
                void navigator.clipboard.writeText(cmd);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }
        } catch {
            // best-effort
        }
    }, [cmd]);

    return (
        <Pressable style={styles.cmdRow} onPress={copy}>
            <Text style={styles.cmd} selectable>{`$ ${cmd}`}</Text>
            {copied ? (
                <Ionicons name="checkmark" size={15} color={theme.colors.success} />
            ) : (
                <Ionicons name="copy-outline" size={15} color={theme.colors.textSecondary} />
            )}
        </Pressable>
    );
}

export function WelcomeInstall() {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (Platform.OS !== 'web') return null;

    return (
        <View style={styles.container}>
            <Text style={styles.introTitle}>A friendly fork of Happy</Text>
            <Text style={styles.introText}>
                <Text style={styles.link} onPress={() => Linking.openURL(REPO_URL)}>Very Happy</Text>
                {' builds on '}
                <Text style={styles.link} onPress={() => Linking.openURL(UPSTREAM_URL)}>Happy</Text>
                {' and trades end-to-end encryption for password-based, multi-device convenience.'}
            </Text>

            <View style={styles.features}>
                {FEATURES.map((f) => (
                    <View key={f.text} style={styles.featureRow}>
                        <Ionicons name={f.icon} size={16} color={theme.colors.textSecondary} />
                        <Text style={styles.featureText}>{f.text}</Text>
                    </View>
                ))}
            </View>

            <View style={styles.divider} />

            <Text style={styles.heading}>Use it on your own computer</Text>

            <View style={styles.step}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>1</Text></View>
                <View style={styles.stepBody}>
                    <Text style={styles.stepText}>
                        Install Claude Code so the `claude` command is on your PATH.
                    </Text>
                </View>
            </View>

            <View style={styles.step}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>2</Text></View>
                <View style={styles.stepBody}>
                    <Text style={styles.stepText}>Install the CLI from npm:</Text>
                    <CommandRow cmd={CLI_INSTALL} />
                </View>
            </View>

            <View style={styles.step}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>3</Text></View>
                <View style={styles.stepBody}>
                    <Text style={styles.stepText}>
                        Run it on the machine you want to control — it's pre-configured to this server:
                    </Text>
                    <CommandRow cmd={CLI_RUN} />
                </View>
            </View>

            <View style={styles.note}>
                <Ionicons name="information-circle-outline" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.noteText}>
                    Your sessions are relayed through this server, whose operator can read their
                    contents. Only sign up if you trust them.
                </Text>
            </View>
        </View>
    );
}
