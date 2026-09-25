import { createContext, useContext, useState, useLayoutEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import * as Updates from 'expo-updates';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { unregisterPushToken } from '@/sync/apiPush';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';
import { markProgrammaticReload } from '@/app/programmaticReload';
import { revokeCloudLogin } from '@/auth/cloudAuth';
import { isAuthLatched, resetAuthLatch } from '@/auth/authLatch';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    // Publish the credentials to the non-React helpers (`getCurrentAuth()`:
    // apiAutomations, teams, useTeamNavigation…). This has to be a LAYOUT
    // effect: React runs a child's passive effects before its parent's, so
    // with `useEffect` a descendant fetching on mount read `null` here and
    // threw a local 401 without sending anything (B-504 — the Automations
    // sidebar entry stayed hidden for a minute or forever in a hidden tab).
    // All layout effects of a commit run before any passive effect does.
    useLayoutEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout } : null);
    }, [isAuthenticated, credentials]);

    const login = async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (success) {
            resetAuthLatch(); // B-490: a fresh token starts with a clean slate
            await syncCreate(newCredentials);
            setCredentials(newCredentials);
            setIsAuthenticated(true);
        } else {
            throw new Error('Failed to save credentials');
        }
    };

    const logout = async () => {
        trackLogout();
        const registeredPushToken = credentials ? loadRegisteredPushToken() : null;
        // B-490: with a rejected token these server calls can only 401 (the
        // guard refuses them anyway) — skip straight to the local sign-out.
        if (credentials && registeredPushToken && !isAuthLatched()) {
            try {
                await unregisterPushToken(credentials, registeredPushToken);
            } catch (error) {
                console.log('Failed to unregister push token during logout:', error);
            }
        }
        if (credentials && !isAuthLatched()) {
            await revokeCloudLogin(credentials);
        }
        clearPersistence();
        await TokenStorage.removeCredentials();

        // Update React state to ensure UI consistency
        setCredentials(null);
        setIsAuthenticated(false);

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
                credentials,
                login,
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
