import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
    TokenStorage,
    type AuthCredentials,
    type E2eeAuthCredentials,
    isE2eeAuthCredentials,
} from '@/auth/tokenStorage';
import { syncCreate, syncLock } from '@/sync/sync';
import * as Updates from 'expo-updates';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { unregisterPushToken } from '@/sync/apiPush';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';
import { markProgrammaticReload } from '@/app/programmaticReload';
import { revokeCloudLogin } from '@/auth/cloudAuth';
import { E2eeIndexedDbKeyVault } from './e2eeVault';
import { establishE2eeLogin } from './e2eeLoginLifecycle';

export type AuthStatus =
    | 'anonymous'
    | 'authenticated-locked'
    | 'authenticated-unavailable'
    | 'authenticated-unlocked';

interface AuthContextType {
    isAuthenticated: boolean;
    isUnlocked: boolean;
    status: AuthStatus;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    loginE2ee: (credentials: E2eeAuthCredentials) => Promise<boolean>;
    lock: () => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({
    children,
    initialCredentials,
    initialStatus = initialCredentials ? 'authenticated-unlocked' : 'anonymous',
}: {
    children: ReactNode;
    initialCredentials: AuthCredentials | null;
    initialStatus?: AuthStatus;
}) {
    const [status, setStatus] = useState<AuthStatus>(initialStatus);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const isAuthenticated = status !== 'anonymous';
    const isUnlocked = status === 'authenticated-unlocked';

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? {
            isAuthenticated, isUnlocked, status, credentials, login, loginE2ee, lock, logout,
        } : null);
    }, [isAuthenticated, isUnlocked, status, credentials]);

    const login = async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (success) {
            await syncCreate(newCredentials);
            setCredentials(newCredentials);
            setStatus('authenticated-unlocked');
        } else {
            throw new Error('Failed to save credentials');
        }
    };

    const loginE2ee = async (newCredentials: E2eeAuthCredentials): Promise<boolean> => {
        const result = await establishE2eeLogin(newCredentials, {
            createSync: syncCreate,
            persistCredentials: TokenStorage.setCredentials,
            lockSync: syncLock,
        });
        setCredentials(newCredentials);
        if (result === 'unlocked') {
            setStatus('authenticated-unlocked');
            return true;
        }
        setStatus('authenticated-locked');
        return false;
    };

    const lock = async () => {
        if (!credentials || !isE2eeAuthCredentials(credentials)) return;
        syncLock();
        setStatus('authenticated-locked');
    };

    const logout = async () => {
        trackLogout();
        const registeredPushToken = credentials ? loadRegisteredPushToken() : null;

        // Destroy in-memory keys and disconnect before any network operation.
        // A stalled relay must never extend the lifetime of decrypted state.
        syncLock();
        setCredentials(null);
        setStatus('anonymous');

        if (credentials && isE2eeAuthCredentials(credentials)) {
            try {
                await new E2eeIndexedDbKeyVault().remove({
                    origin: credentials.origin,
                    accountId: credentials.accountId,
                    deviceId: credentials.deviceId,
                });
            } catch (error) {
                console.log('Failed to remove local E2EE vault during logout:', error);
            }
        }
        clearPersistence();
        await TokenStorage.removeCredentials();

        // Server revocation is best-effort. It uses the captured credential but
        // is deliberately not on the local key-erasure/reload critical path.
        if (credentials) {
            void Promise.allSettled([
                registeredPushToken
                    ? unregisterPushToken(credentials, registeredPushToken)
                    : Promise.resolve(),
                revokeCloudLogin(credentials),
            ]).then((results) => {
                for (const result of results) {
                    if (result.status === 'rejected') {
                        console.log('Failed to finish remote logout cleanup:', result.reason);
                    }
                }
            });
        }
        
        if (Platform.OS === 'web') {
            // Logout is already confirmed by its own dialog — the tab-close
            // guard must not ask a second time.
            markProgrammaticReload();
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                // In dev mode, reloadAsync will throw ERR_UPDATES_DISABLED
                console.log('Reload failed (expected in dev mode):', error);
            }
        }
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                isUnlocked,
                status,
                credentials,
                login,
                loginE2ee,
                lock,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
