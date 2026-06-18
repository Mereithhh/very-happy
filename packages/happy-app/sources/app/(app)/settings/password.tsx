import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { setAccountCredentials, AccountAuthError } from '@/auth/passwordUnlock';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { t } from '@/text';

const MIN_PASSWORD_LENGTH = 8;

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 32,
    },
    card: {
        width: '100%',
        maxWidth: 420,
        backgroundColor: theme.colors.surface,
        borderRadius: 20,
        paddingHorizontal: 24,
        paddingVertical: 28,
        ...Platform.select({
            web: {
                boxShadow: `0px 10px 32px ${theme.dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.07)'}`,
            },
            default: {
                shadowColor: theme.colors.shadow.color,
                shadowOpacity: theme.colors.shadow.opacity,
                shadowRadius: 20,
                shadowOffset: { width: 0, height: 10 },
                elevation: 5,
            },
        }),
    },
    intro: {
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        marginBottom: 24,
        ...Typography.default(),
    },
    label: {
        fontSize: 12,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    input: {
        backgroundColor: theme.colors.input.background,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 12,
        fontSize: 16,
        color: theme.colors.input.text,
        borderWidth: 1,
        marginBottom: 18,
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
        marginTop: -8,
        marginBottom: 18,
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
        marginTop: 8,
    },
}));

export default function SetPassword() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = async () => {
        if (!username.trim()) {
            setError('Please enter a username.');
            return;
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(t('setPassword.errorTooShort', { count: MIN_PASSWORD_LENGTH }));
            return;
        }
        if (password !== confirm) {
            setError(t('setPassword.errorMismatch'));
            return;
        }
        const credentials = auth.credentials;
        if (!credentials) {
            setError(t('setPassword.errorNotAuthenticated'));
            return;
        }

        setLoading(true);
        setError(null);
        try {
            // credentials.secret = base64url(32B account secret key)；createPasswordBlob 全在本地。
            await setAccountCredentials(username, password, credentials.secret, credentials);
            setPassword('');
            setConfirm('');
            Modal.alert(t('common.success'), t('setPassword.success'));
            if (router.canGoBack()) {
                router.back();
            }
        } catch (e) {
            if (e instanceof AccountAuthError && e.code === 'username-taken') {
                setError('That username is taken.');
            } else {
                setError(t('setPassword.errorSaveFailed'));
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <ScrollView style={styles.scrollView} keyboardShouldPersistTaps="handled">
            <View style={styles.container}>
                <View style={styles.card}>
                    <Text style={styles.intro}>{t('setPassword.intro')}</Text>

                    <Text style={styles.label}>Username</Text>
                    <TextInput
                        style={[styles.input, error ? styles.inputError : styles.inputDefault]}
                        placeholder="username"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={username}
                        onChangeText={(text) => {
                            setUsername(text);
                            if (error) setError(null);
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={!loading}
                    />

                    <Text style={styles.label}>{t('setPassword.passwordLabel')}</Text>
                    <TextInput
                        style={[styles.input, error ? styles.inputError : styles.inputDefault]}
                        placeholder={t('setPassword.passwordPlaceholder')}
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
                    />

                    <Text style={styles.label}>{t('setPassword.confirmLabel')}</Text>
                    <TextInput
                        style={[styles.input, error ? styles.inputError : styles.inputDefault]}
                        placeholder={t('setPassword.confirmPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={confirm}
                        onChangeText={(text) => {
                            setConfirm(text);
                            if (error) setError(null);
                        }}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={!loading}
                        onSubmitEditing={handleSave}
                        returnKeyType="done"
                    />

                    {error && (
                        <Animated.View entering={FadeIn.duration(200)} style={styles.errorRow}>
                            <Ionicons name="alert-circle" size={16} color={theme.colors.box.error.text} />
                            <Text style={styles.errorText}>{error}</Text>
                        </Animated.View>
                    )}

                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('setPassword.save')}
                            loading={loading}
                            disabled={loading}
                            onPress={handleSave}
                        />
                    </View>
                </View>
            </View>
        </ScrollView>
    );
}
