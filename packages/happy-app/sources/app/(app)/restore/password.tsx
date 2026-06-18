import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { unlockWithPassword, PasswordUnlockError } from '@/auth/passwordUnlock';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingVertical: 48,
        minHeight: '100%',
    },
    card: {
        width: '100%',
        maxWidth: 380,
        backgroundColor: theme.colors.surface,
        borderRadius: 20,
        paddingHorizontal: 24,
        paddingVertical: 32,
        alignItems: 'center',
        ...Platform.select({
            web: {
                boxShadow: `0px 12px 40px ${theme.dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.08)'}`,
            },
            default: {
                shadowColor: theme.colors.shadow.color,
                shadowOpacity: theme.colors.shadow.opacity,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: 12 },
                elevation: 6,
            },
        }),
    },
    iconCircle: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: theme.colors.groupped.background,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
    },
    title: {
        fontSize: 22,
        textAlign: 'center',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 15,
        lineHeight: 21,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        marginTop: 8,
        marginBottom: 28,
        ...Typography.default(),
    },
    inputWrapper: {
        width: '100%',
        marginBottom: 8,
    },
    input: {
        backgroundColor: theme.colors.input.background,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 12,
        fontSize: 16,
        color: theme.colors.input.text,
        borderWidth: 1,
        ...Typography.default(),
    },
    inputDefault: {
        borderColor: 'transparent',
    },
    inputError: {
        borderColor: theme.colors.box.error.border,
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        marginTop: 10,
        marginBottom: 2,
        gap: 6,
    },
    errorText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.box.error.text,
        ...Typography.default(),
    },
    buttonWrapper: {
        width: '100%',
        marginTop: 24,
    },
}));

export default function PasswordLogin() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleUnlock = async () => {
        const value = password;
        if (!value) {
            setError(t('passwordLogin.errorEmpty'));
            return;
        }
        setLoading(true);
        setError(null);
        try {
            // 本地解回 account key → 派生 token；密码永不发服务端。
            const credentials = await unlockWithPassword(value);
            // 复用标准 bootstrap：写凭据 + syncCreate（与扫码配对完全等价）。
            await auth.login(credentials.token, credentials.secret);
            // login 成功后 AuthContext 切换 isAuthenticated，根路由自动进主界面。
            if (router.canGoBack()) {
                router.back();
            }
        } catch (e) {
            if (e instanceof PasswordUnlockError) {
                if (e.code === 'no-password') {
                    setError(t('passwordLogin.errorNoPassword'));
                } else if (e.code === 'wrong-password') {
                    setError(t('passwordLogin.errorWrongPassword'));
                } else {
                    setError(t('passwordLogin.errorNetwork'));
                }
            } else {
                setError(t('passwordLogin.errorNetwork'));
            }
            setPassword('');
        } finally {
            setLoading(false);
        }
    };

    return (
        <ScrollView
            style={styles.scrollView}
            contentContainerStyle={{ flexGrow: 1 }}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.container}>
                <Animated.View entering={FadeInDown.duration(350)} style={styles.card}>
                    <View style={styles.iconCircle}>
                        <Ionicons name="lock-closed-outline" size={30} color={theme.colors.textSecondary} />
                    </View>
                    <Text style={styles.title}>{t('passwordLogin.title')}</Text>
                    <Text style={styles.subtitle}>{t('passwordLogin.subtitle')}</Text>

                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={[styles.input, error ? styles.inputError : styles.inputDefault]}
                            placeholder={t('passwordLogin.passwordPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={password}
                            onChangeText={(text) => {
                                setPassword(text);
                                if (error) setError(null);
                            }}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                            onSubmitEditing={handleUnlock}
                            returnKeyType="go"
                            autoFocus
                        />
                        {error && (
                            <Animated.View entering={FadeIn.duration(200)} style={styles.errorRow}>
                                <Ionicons name="alert-circle" size={16} color={theme.colors.box.error.text} />
                                <Text style={styles.errorText}>{error}</Text>
                            </Animated.View>
                        )}
                    </View>

                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('passwordLogin.unlock')}
                            loading={loading}
                            disabled={loading}
                            onPress={handleUnlock}
                        />
                    </View>
                </Animated.View>
            </View>
        </ScrollView>
    );
}
