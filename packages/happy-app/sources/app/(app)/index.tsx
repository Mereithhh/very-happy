import { useAuth } from "@/auth/AuthContext";
import { Text, View, Platform, ScrollView, Pressable, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
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

/** Cyber-styled CTA button (web + native safe). */
function CyberButton({ label, onPress, variant = 'primary' }: {
    label: string;
    onPress: () => void;
    variant?: 'primary' | 'secondary';
}) {
    const [hovered, setHovered] = React.useState(false);
    const webHover = Platform.OS === 'web'
        ? { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) }
        : {};

    if (variant === 'primary') {
        return (
            <Pressable
                onPress={onPress}
                {...webHover}
                style={({ pressed }) => [
                    styles.btnBase,
                    Platform.OS === 'web' ? ({ filter: hovered ? `drop-shadow(0 0 16px ${CYBER.cyan}cc)` : `drop-shadow(0 0 8px ${CYBER.cyan}66)` } as any) : null,
                    { opacity: pressed ? 0.85 : 1 },
                ]}
            >
                <LinearGradient
                    colors={[CYBER.cyan, CYBER.violet]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.btnFill}
                >
                    <Text style={styles.btnPrimaryText}>{label}</Text>
                </LinearGradient>
            </Pressable>
        );
    }
    return (
        <Pressable
            onPress={onPress}
            {...webHover}
            style={({ pressed }) => [
                styles.btnBase,
                styles.btnSecondary,
                { borderColor: hovered ? CYBER.cyan : CYBER.cardBorder, opacity: pressed ? 0.85 : 1 },
            ]}
        >
            <Text style={styles.btnSecondaryText}>{label}</Text>
        </Pressable>
    );
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const isWide = width >= 880;

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            console.error('Error creating account', error);
        }
    };

    const isWebClient = Platform.OS !== 'android' && Platform.OS !== 'ios';

    return (
        <View style={styles.root}>
            <CyberBackdrop />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 48 },
                ]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                <View style={[styles.hero, { maxWidth: isWide ? 600 : 460 }]}>
                    <Text style={styles.kicker}>SELF-HOSTED · CLAUDE CODE</Text>

                    <CyberMark size={isWide ? 84 : 72} />

                    <Text style={[styles.title, { fontSize: isWide ? 56 : 42 }]}>Very Happy</Text>

                    <Text style={[styles.tagline, { fontSize: isWide ? 20 : 17 }]}>
                        {t('welcome.title')}
                    </Text>
                    <Text style={styles.subtitle}>
                        {t('welcome.subtitle')}
                    </Text>

                    <View style={styles.buttons}>
                        {isWebClient ? (
                            <>
                                <CyberButton label={t('welcome.loginWithPassword')} onPress={() => router.push('/restore/password')} />
                                <CyberButton label={t('welcome.createAccount')} variant="secondary" onPress={() => router.push('/restore/signup')} />
                            </>
                        ) : (
                            <>
                                <CyberButton label={t('welcome.createAccount')} onPress={createAccount} />
                                <CyberButton
                                    label={t('welcome.linkOrRestoreAccount')}
                                    variant="secondary"
                                    onPress={() => { trackAccountRestored(); router.push('/restore'); }}
                                />
                            </>
                        )}
                    </View>

                    <WelcomeInstall />
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        flex: 1,
        backgroundColor: CYBER.bg0,
    },
    scrollContent: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
    },
    hero: {
        width: '100%',
        alignItems: 'center',
    },
    kicker: {
        ...Typography.mono(),
        fontSize: 12,
        letterSpacing: 3,
        color: CYBER.cyan,
        marginBottom: 22,
    },
    title: {
        ...Typography.default('semiBold'),
        color: CYBER.text,
        letterSpacing: 0.5,
        textAlign: 'center',
        marginTop: 18,
    },
    tagline: {
        ...Typography.default('semiBold'),
        color: CYBER.text,
        textAlign: 'center',
        marginTop: 14,
        opacity: 0.92,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 22,
        color: CYBER.textDim,
        textAlign: 'center',
        marginTop: 12,
        marginHorizontal: 8,
        maxWidth: 440,
    },
    buttons: {
        width: '100%',
        maxWidth: 320,
        marginTop: 34,
        gap: 12,
    },
    btnBase: {
        width: '100%',
        borderRadius: 14,
        overflow: 'hidden',
    },
    btnFill: {
        height: 52,
        alignItems: 'center',
        justifyContent: 'center',
    },
    btnPrimaryText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: '#06080F',
        letterSpacing: 0.3,
    },
    btnSecondary: {
        height: 52,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        backgroundColor: 'rgba(255,255,255,0.02)',
    },
    btnSecondaryText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: CYBER.text,
        letterSpacing: 0.3,
    },
}));
