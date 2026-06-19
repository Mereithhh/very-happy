/**
 * Account signup (username + password) for the self-hosted, server-trusted,
 * web-only instance. Lets a brand-new user register on this server so others
 * can use it without QR pairing.
 *
 * Flow: generate a fresh account secret → create the account (authGetToken) →
 * attach username+password+secret via setAccountCredentials → only THEN flip to
 * authenticated. Doing credentials BEFORE login means a taken username (409)
 * leaves no half-created signed-in state — the user just retries.
 *
 * ⚠️ Server-trusted: the account secret is sent to and stored by the server, so
 * the server operator can decrypt this account's data. Acceptable only because
 * users knowingly trust this operator.
 */

import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { getRandomBytesAsync } from 'expo-crypto';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { authGetToken } from '@/auth/authGetToken';
import { encodeBase64 } from '@/encryption/base64';
import { setAccountCredentials, AccountAuthError } from '@/auth/passwordUnlock';
import { trackAccountCreated } from '@/track';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

const MIN_PASSWORD = 8;

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
    loginLink: {
        marginTop: 18,
        fontSize: 14,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
}));

export default function Signup() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [invite, setInvite] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSignup = async () => {
        const user = username.trim().toLowerCase();
        if (!user || !password) {
            setError('Enter a username and password.');
            return;
        }
        if (user.length < 3) {
            setError('Username must be at least 3 characters.');
            return;
        }
        if (password.length < MIN_PASSWORD) {
            setError(`Password must be at least ${MIN_PASSWORD} characters.`);
            return;
        }
        if (password !== confirm) {
            setError('Passwords do not match.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            // 1) Create a fresh account from a random secret. The invite code (if
            //    the server runs invite-only) is checked here, at account create.
            const secret = await getRandomBytesAsync(32);
            const secretB64 = encodeBase64(secret, 'base64url');
            const token = await authGetToken(secret, invite.trim() || undefined);
            // 2) Attach username+password (and stash the secret server-side).
            //    Done before login so a 409 leaves no signed-in half-state.
            await setAccountCredentials(user, password, secretB64, { token, secret: secretB64 });
            // 3) Now switch to authenticated — root route enters the app.
            await auth.login(token, secretB64);
            trackAccountCreated();
            if (router.canGoBack()) {
                router.back();
            }
        } catch (e: any) {
            const status = e?.response?.status;
            const serverError = e?.response?.data?.error;
            if (e instanceof AccountAuthError && e.code === 'username-taken') {
                setError('That username is taken. Pick another.');
            } else if (e instanceof AccountAuthError && e.code === 'rate-limited') {
                setError('Too many attempts. Wait a minute and try again.');
            } else if (status === 403 && serverError === 'invite-required') {
                setError('A valid invite code is required to sign up here.');
            } else if (status === 403 && serverError === 'signup-closed') {
                setError('Signups are currently closed on this server.');
            } else {
                setError('Could not create the account. Please try again.');
            }
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
                        <Ionicons name="person-add-outline" size={30} color={theme.colors.textSecondary} />
                    </View>
                    <Text style={styles.title}>Create your account</Text>
                    <Text style={styles.subtitle}>
                        Pick a username and password. You can then sign in from any device.
                    </Text>

                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={[styles.input, styles.inputDefault]}
                            placeholder="Username"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={username}
                            onChangeText={(text) => { setUsername(text); if (error) setError(null); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                            returnKeyType="next"
                            autoFocus
                        />
                    </View>

                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={[styles.input, styles.inputDefault]}
                            placeholder="Password"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={password}
                            onChangeText={(text) => { setPassword(text); if (error) setError(null); }}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                            returnKeyType="next"
                        />
                    </View>

                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={[styles.input, styles.inputDefault]}
                            placeholder="Confirm password"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={confirm}
                            onChangeText={(text) => { setConfirm(text); if (error) setError(null); }}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                            returnKeyType="next"
                        />
                    </View>

                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={[styles.input, error ? styles.inputError : styles.inputDefault]}
                            placeholder="Invite code (if required)"
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={invite}
                            onChangeText={(text) => { setInvite(text); if (error) setError(null); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                            onSubmitEditing={handleSignup}
                            returnKeyType="go"
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
                            title="Create account"
                            loading={loading}
                            disabled={loading}
                            onPress={handleSignup}
                        />
                    </View>

                    <Text
                        style={styles.loginLink}
                        onPress={() => router.replace('/restore/password')}
                    >
                        Already have an account? Log in
                    </Text>
                </Animated.View>
            </View>
        </ScrollView>
    );
}
