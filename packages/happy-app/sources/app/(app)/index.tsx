import { useAuth } from "@/auth/AuthContext";
import { Text, View, Platform, ScrollView, Pressable, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { getRandomBytesAsync } from "expo-crypto";
import { Typography } from "@/constants/Typography";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { MainView } from "@/components/MainView";
import { WelcomeInstall } from "@/components/WelcomeInstall";
import { CyberBackdrop, CYBER } from "@/components/CyberBackdrop";
import { CyberMark } from "@/components/CyberMark";
import { SessionConsole } from "@/components/SessionConsole";
import { t } from '@/text';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    return <MainView variant="phone" />;
}

/** Single-accent CTA. Solid accent for primary, hairline outline for secondary. */
function CyberButton({ label, onPress, variant = 'primary', loading }: {
    label: string;
    onPress: () => void;
    variant?: 'primary' | 'secondary';
    loading?: boolean;
}) {
    const [hovered, setHovered] = React.useState(false);
    const webHover = Platform.OS === 'web'
        ? { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) }
        : {};
    const isPrimary = variant === 'primary';

    return (
        <Pressable
            onPress={loading ? undefined : onPress}
            disabled={loading}
            {...webHover}
            style={({ pressed }) => [
                styles.btn,
                isPrimary ? styles.btnPrimary : styles.btnSecondary,
                !isPrimary && { borderColor: hovered ? CYBER.accent : CYBER.border },
                Platform.OS === 'web' && isPrimary
                    ? ({ filter: hovered ? `drop-shadow(0 0 18px ${CYBER.accent}aa)` : `drop-shadow(0 0 8px ${CYBER.accent}55)` } as any)
                    : null,
                { opacity: pressed || loading ? 0.7 : 1 },
            ]}
        >
            <Text style={isPrimary ? styles.btnPrimaryText : styles.btnSecondaryText}>
                {loading ? '…' : label}
            </Text>
        </Pressable>
    );
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const isWide = width >= 980;
    const [creating, setCreating] = React.useState(false);

    const createAccount = async () => {
        setCreating(true);
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            console.error('Error creating account', error);
        } finally {
            setCreating(false);
        }
    };

    const isWebClient = Platform.OS !== 'android' && Platform.OS !== 'ios';

    const brand = (
        <View style={[styles.brand, isWide && styles.brandWide]}>
            <Text style={styles.kicker}>SELF-HOSTED · CLAUDE CODE</Text>
            <View style={[styles.markRow, isWide && { alignSelf: 'flex-start' }]}>
                <CyberMark size={44} />
                <Text style={[styles.wordmark, { fontSize: isWide ? 44 : 36 }]}>Very Happy</Text>
            </View>
            <Text style={[styles.tagline, isWide && styles.taglineWide]}>Claude Code & Codex, from any browser</Text>
            <Text style={[styles.subtitle, isWide && styles.subtitleWide]}>在任意浏览器里掌控你的编码 agent —— 密码登录、多设备同步、可自托管。</Text>

            <View style={[styles.buttons, isWide && styles.buttonsWide]}>
                {isWebClient ? (
                    <>
                        <CyberButton label={t('welcome.loginWithPassword')} onPress={() => router.push('/restore/password')} />
                        <CyberButton label={t('welcome.createAccount')} variant="secondary" onPress={() => router.push('/restore/signup')} />
                    </>
                ) : (
                    <>
                        <CyberButton label={t('welcome.createAccount')} loading={creating} onPress={createAccount} />
                        <CyberButton
                            label={t('welcome.linkOrRestoreAccount')}
                            variant="secondary"
                            onPress={() => { trackAccountRestored(); router.push('/restore'); }}
                        />
                    </>
                )}
            </View>
        </View>
    );

    return (
        <View style={styles.root}>
            <CyberBackdrop />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingTop: insets.top + 44, paddingBottom: insets.bottom + 56 },
                ]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                <View style={[styles.stage, { maxWidth: isWide ? 960 : 460 }]}>
                    {isWide ? (
                        <View style={styles.heroRow}>
                            <View style={styles.heroCol}>{brand}</View>
                            <View style={styles.heroColRight}><SessionConsole /></View>
                        </View>
                    ) : (
                        <>
                            {brand}
                            <View style={styles.consoleNarrow}><SessionConsole /></View>
                        </>
                    )}
                    <WelcomeInstall />
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: { flex: 1, backgroundColor: CYBER.bg0 },
    scrollContent: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 22,
    },
    stage: { width: '100%', alignItems: 'center' },

    heroRow: { flexDirection: 'row', alignItems: 'center', gap: 56, width: '100%' },
    heroCol: { flex: 1 },
    heroColRight: { flex: 1, alignItems: 'flex-end' },

    brand: { width: '100%', alignItems: 'center' },
    brandWide: { alignItems: 'flex-start' },

    kicker: {
        ...Typography.mono(),
        fontSize: 12,
        letterSpacing: 3,
        color: CYBER.accent,
        marginBottom: 20,
    },
    markRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    wordmark: {
        ...Typography.mono(),
        color: CYBER.text,
        letterSpacing: -0.5,
    },
    tagline: {
        ...Typography.default('semiBold'),
        fontSize: 22,
        lineHeight: 30,
        color: CYBER.text,
        textAlign: 'center',
        marginTop: 18,
        opacity: 0.95,
    },
    taglineWide: { textAlign: 'left', fontSize: 26, lineHeight: 34 },
    subtitle: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 22,
        color: CYBER.textDim,
        textAlign: 'center',
        marginTop: 12,
        maxWidth: 420,
    },
    subtitleWide: { textAlign: 'left' },

    buttons: { width: '100%', maxWidth: 340, marginTop: 30, gap: 12 },
    buttonsWide: { flexDirection: 'row', maxWidth: 420 },

    btn: {
        flex: 1,
        height: 52,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
    },
    btnPrimary: { backgroundColor: CYBER.accent },
    btnPrimaryText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: CYBER.accentText,
        letterSpacing: 0.3,
    },
    btnSecondary: {
        borderWidth: 1,
        backgroundColor: 'rgba(255,255,255,0.02)',
    },
    btnSecondaryText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: CYBER.text,
        letterSpacing: 0.3,
    },

    consoleNarrow: { width: '100%', alignItems: 'center', marginTop: 36 },
}));
