/**
 * WelcomeInstall — the cyber landing card on the unauthenticated welcome
 * screen (web only). Tells the very-happy story (a friendly fork of Happy,
 * with what it adds), the three-step install, and an honest server-trusted
 * disclosure. Styled to sit inside the dark cyber hero (explicit palette, not
 * theme-driven, since the landing is art-directed dark).
 */

import * as React from 'react';
import { View, Text, Pressable, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { CYBER } from '@/components/CyberBackdrop';

const CLI_INSTALL = 'npm i -g very-happy-cli';
const CLI_RUN = 'very-happy';
const REPO_URL = 'https://github.com/Mereithhh/very-happy';
const UPSTREAM_URL = 'https://github.com/slopus/happy';

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
    { icon: 'key-outline', text: 'Password sign-in, any device · 密码登录，任意设备，免扫码' },
    { icon: 'sync-outline', text: 'Multi-device sync · 多设备实时同步，会话随身' },
    { icon: 'terminal-outline', text: 'Web terminal over tmux · 浏览器里的真实终端' },
    { icon: 'sparkles-outline', text: 'Latest models + reworked UI · 最新模型 + 重做的界面' },
];

const stylesheet = StyleSheet.create(() => ({
    container: {
        width: '100%',
        maxWidth: 460,
        marginTop: 40,
        paddingHorizontal: 22,
        paddingVertical: 22,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: CYBER.border,
        backgroundColor: CYBER.panel,
    },
    introTitle: {
        fontSize: 15,
        color: CYBER.text,
        ...Typography.default('semiBold'),
        marginBottom: 6,
    },
    introText: {
        fontSize: 13,
        lineHeight: 19,
        color: CYBER.textDim,
        ...Typography.default(),
    },
    link: {
        color: CYBER.accent,
        ...Typography.default('semiBold'),
    },
    features: {
        marginTop: 16,
        gap: 10,
    },
    featureRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    featureText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        color: CYBER.text,
        ...Typography.default(),
    },
    divider: {
        height: 1,
        backgroundColor: CYBER.border,
        marginVertical: 20,
        opacity: 0.6,
    },
    heading: {
        fontSize: 13,
        color: CYBER.textDim,
        letterSpacing: 1.5,
        ...Typography.default('semiBold'),
        marginBottom: 16,
    },
    step: {
        flexDirection: 'row',
        gap: 11,
        marginBottom: 13,
    },
    stepNum: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: CYBER.border,
        backgroundColor: CYBER.accentDim,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    stepNumText: {
        fontSize: 11,
        color: CYBER.accent,
        ...Typography.default('semiBold'),
    },
    stepBody: {
        flex: 1,
    },
    stepText: {
        fontSize: 14,
        lineHeight: 20,
        color: CYBER.text,
        ...Typography.default(),
    },
    cmdRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 7,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: CYBER.border,
        backgroundColor: 'rgba(0,0,0,0.35)',
    },
    cmd: {
        flex: 1,
        fontSize: 13,
        color: CYBER.accent,
        ...Typography.mono(),
    },
    note: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 8,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: CYBER.border,
    },
    noteText: {
        flex: 1,
        fontSize: 12,
        lineHeight: 17,
        color: CYBER.textDim,
        ...Typography.default(),
    },
}));

function CommandRow({ cmd }: { cmd: string }) {
    const styles = stylesheet;
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
                <Ionicons name="checkmark" size={15} color={CYBER.accent} />
            ) : (
                <Ionicons name="copy-outline" size={15} color={CYBER.textDim} />
            )}
        </Pressable>
    );
}

export function WelcomeInstall() {
    const styles = stylesheet;

    if (Platform.OS !== 'web') return null;

    return (
        <View style={styles.container}>
            <Text style={styles.introTitle}>A friendly fork of Happy · 基于 Happy 的友好分支</Text>
            <Text style={styles.introText}>
                <Text style={styles.link} onPress={() => Linking.openURL(REPO_URL)}>Very Happy</Text>
                {' builds on '}
                <Text style={styles.link} onPress={() => Linking.openURL(UPSTREAM_URL)}>Happy</Text>
                {' and trades end-to-end encryption for password-based, multi-device convenience.'}
                {'\n用密码登录代替端到端加密，换来多设备即开即用的便利。'}
            </Text>

            <View style={styles.features}>
                {FEATURES.map((f) => (
                    <View key={f.text} style={styles.featureRow}>
                        <Ionicons name={f.icon} size={16} color={CYBER.accent} />
                        <Text style={styles.featureText}>{f.text}</Text>
                    </View>
                ))}
            </View>

            <View style={styles.divider} />

            <Text style={styles.heading}>USE IT ON YOUR OWN COMPUTER · 在你自己的电脑上运行</Text>

            <View style={styles.step}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>1</Text></View>
                <View style={styles.stepBody}>
                    <Text style={styles.stepText}>
                        Install Claude Code so the `claude` command is on your PATH.
                        {'\n安装 Claude Code，确保 claude 命令在 PATH 上。'}
                    </Text>
                </View>
            </View>

            <View style={styles.step}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>2</Text></View>
                <View style={styles.stepBody}>
                    <Text style={styles.stepText}>Install the CLI from npm · 从 npm 安装 CLI：</Text>
                    <CommandRow cmd={CLI_INSTALL} />
                </View>
            </View>

            <View style={styles.step}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>3</Text></View>
                <View style={styles.stepBody}>
                    <Text style={styles.stepText}>
                        Run it on the machine you want to control — pre-configured to this server.
                        {'\n在你想控制的机器上运行，已预设连到本服务器。'}
                    </Text>
                    <CommandRow cmd={CLI_RUN} />
                </View>
            </View>

            <View style={styles.note}>
                <Ionicons name="information-circle-outline" size={16} color={CYBER.textDim} />
                <Text style={styles.noteText}>
                    Server-trusted: your sessions are relayed through this server, whose operator can
                    read them. Only sign up if you trust them. · 服务器可见你的会话内容，信任再注册。
                </Text>
            </View>
        </View>
    );
}
