import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { CommandPalette } from './CommandPalette';
import { Command } from './types';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionName } from '@/utils/sessionUtils';
import { useMachineTerminals, type MachineTerminalsGroup } from '@/hooks/useMachineTerminals';
import { type MachineTerminal } from '@/sync/ops';
import { t } from '@/text';

// Max number of session/terminal entries to surface as commands. The palette
// filters by input itself, so this is just a safety cap on very large workspaces.
const MAX_ENTRIES = 50;

function terminalTitle(term: MachineTerminal): string {
    if (term.title && term.title.trim()) return term.title.trim();
    if (term.cwd) {
        const segs = term.cwd.replace(/\\/g, '/').split('/').filter(Boolean);
        if (segs.length) return segs[segs.length - 1];
    }
    return term.id;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { logout } = useAuth();
    const sessions = storage(useShallow((state) => state.sessions));
    const commandPaletteEnabled = storage(useShallow((state) => state.localSettings.commandPaletteEnabled));
    const navigateToSession = useNavigateToSession();
    // Terminals are a web-only feature; the palette itself is web-only too, so
    // gate the RPC fan-out on web to avoid needless polling on native.
    const terminals = useMachineTerminals(Platform.OS === 'web');

    // Define available commands
    const commands = useMemo((): Command[] => {
        const cmds: Command[] = [
            // Navigation commands
            {
                id: 'new-session',
                title: t('commandPalette.newSession'),
                subtitle: t('commandPalette.newSessionSubtitle'),
                icon: 'add-circle-outline',
                category: t('commandPalette.categorySessions'),
                shortcut: '⌘N',
                action: () => {
                    router.navigate('/new');
                }
            },
            {
                id: 'sessions',
                title: t('commandPalette.viewAllSessions'),
                subtitle: t('commandPalette.viewAllSessionsSubtitle'),
                icon: 'chatbubbles-outline',
                category: t('commandPalette.categorySessions'),
                action: () => {
                    router.push('/');
                }
            },
            {
                id: 'settings',
                title: t('commandPalette.settings'),
                subtitle: t('commandPalette.settingsSubtitle'),
                icon: 'settings-outline',
                category: t('commandPalette.categoryNavigation'),
                shortcut: '⌘,',
                action: () => {
                    router.push('/settings');
                }
            },
            {
                id: 'account',
                title: t('commandPalette.account'),
                subtitle: t('commandPalette.accountSubtitle'),
                icon: 'person-circle-outline',
                category: t('commandPalette.categoryNavigation'),
                action: () => {
                    router.push('/settings/account');
                }
            },
            {
                id: 'connect',
                title: t('commandPalette.connectDevice'),
                subtitle: t('commandPalette.connectDeviceSubtitle'),
                icon: 'link-outline',
                category: t('commandPalette.categoryNavigation'),
                action: () => {
                    router.push('/terminal/connect');
                }
            },
        ];

        // Active sessions — same source/criteria as the sidebar (session.active),
        // titled with getSessionName so the real name (not the ID) is searchable.
        // Sorted by most recent activity, capped at MAX_ENTRIES.
        const activeSessions = Object.values(sessions)
            .filter(session => session.active)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_ENTRIES);

        activeSessions.forEach(session => {
            cmds.push({
                id: `session-${session.id}`,
                title: getSessionName(session),
                subtitle: session.metadata?.path || t('commandPalette.switchToSession'),
                icon: 'time-outline',
                category: t('commandPalette.categoryRecentSessions'),
                action: () => {
                    navigateToSession(session.id);
                }
            });
        });

        // Live web terminals (tmux) across all online machines — each is its own
        // command so terminals are searchable by title/cwd just like sessions.
        terminals.forEach((group: MachineTerminalsGroup) => {
            group.terminals.forEach(term => {
                cmds.push({
                    id: `terminal-${group.machineId}-${term.id}`,
                    title: terminalTitle(term),
                    subtitle: group.machineName || term.cwd || '',
                    icon: 'terminal-outline',
                    category: t('commandPalette.categoryTerminals'),
                    action: () => {
                        router.push(`/terminal/web/${group.machineId}?tid=${term.id}` as any);
                    }
                });
            });
        });

        // System commands
        cmds.push({
            id: 'sign-out',
            title: t('commandPalette.signOut'),
            subtitle: t('commandPalette.signOutSubtitle'),
            icon: 'log-out-outline',
            category: t('commandPalette.categorySystem'),
            action: async () => {
                await logout();
            }
        });

        // Dev commands (if in development)
        if (__DEV__) {
            cmds.push({
                id: 'dev-menu',
                title: t('commandPalette.developerMenu'),
                subtitle: t('commandPalette.developerMenuSubtitle'),
                icon: 'code-slash-outline',
                category: t('commandPalette.categoryDeveloper'),
                action: () => {
                    router.push('/dev');
                }
            });
        }

        return cmds;
    }, [router, logout, sessions, terminals, navigateToSession]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || !commandPaletteEnabled) return;

        Modal.show({
            component: CommandPalette,
            props: {
                commands,
            }
        } as any);
    }, [commands, commandPaletteEnabled]);

    // Set up global keyboard handler only if feature is enabled
    useGlobalKeyboard(commandPaletteEnabled ? showCommandPalette : () => {});

    return <>{children}</>;
}
