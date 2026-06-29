import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Text } from '@/components/StyledText';
import { Machine } from '@/sync/storageTypes';
import { SessionRowData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { type SessionState, formatPathRelativeToHome, vibingMessages, formatLastSeen } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { StatusDot, StatusDotKind } from './StatusDot';
import { useAllMachines, useSessionGitStatus } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { sessionKill, machineKillTerminal, machineSetTerminalTitle, type MachineTerminal } from '@/sync/ops';
import { isWorktreePath, getRepoPath, getWorktreeName } from '@/utils/worktree';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useRouter, usePathname, useGlobalSearchParams } from 'expo-router';
import { Modal } from '@/modal';
import { type MachineTerminalsGroup } from '@/hooks/useMachineTerminals';
import { useCommandKeyHeld } from '@/hooks/useCommandKeyHeld';
import { useSessionQuickSwitchMap } from '@/hooks/useSessionQuickSwitchMap';
import { QuickSwitchBadge } from './QuickSwitchBadge';

const getStatusConfig = (theme: any): Record<SessionState, { color: string; kind: StatusDotKind; accessibilityLabel: string; isConnected: boolean }> => ({
    disconnected: { color: theme.colors.status.disconnected, kind: 'offline', accessibilityLabel: t('status.offline'), isConnected: false },
    thinking: { color: theme.colors.status.connected, kind: 'thinking', accessibilityLabel: t('status.connected'), isConnected: true },
    waiting: { color: theme.colors.status.connected, kind: 'connected', accessibilityLabel: t('status.connected'), isConnected: true },
    permission_required: { color: theme.colors.status.connecting, kind: 'permission', accessibilityLabel: t('status.permissionRequired'), isConnected: true },
});

interface ActiveSessionsGroupProps {
    sessions: SessionRowData[];
    selectedSessionId?: string;
    // Live tmux terminals (web only). Folded into the same machine→project
    // groups as Claude sessions — a terminal is just another kind of session.
    terminals?: MachineTerminalsGroup[];
}

interface ProjectGroup {
    path: string;
    displayPath: string;
    homeDir: string | null;
    machineId: string;
    // First session in the group — used to look up git status for the header.
    gitSessionId: string | null;
    // Newest createdAt across the group's sessions + terminals — groups sort by
    // this (most recently active on top).
    lastActivity: number;
    sessions: SessionRowData[];
    terminals: MachineTerminal[];
}

/**
 * Hook to get git display info for a section header:
 * branch name, line changes, and worktree status.
 */
function useSectionGitInfo(sessionId: string | null) {
    const gitStatus = useSessionGitStatus(sessionId ?? '');

    return React.useMemo(() => {
        if (!sessionId || !gitStatus || gitStatus.lastUpdatedAt === 0) {
            return { branch: null, linesAdded: 0, linesRemoved: 0, hasChanges: false };
        }
        return {
            branch: gitStatus.branch,
            linesAdded: gitStatus.unstagedLinesAdded,
            linesRemoved: gitStatus.unstagedLinesRemoved,
            hasChanges: gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0,
        };
    }, [gitStatus, sessionId]);
}

// Section header: path (folder) + branch + tree icon + line changes | + button.
// No avatar — for a single account the per-path identicon was decorative noise;
// the path itself is the meaningful, distinguishing label.
const SectionHeader = React.memo(({ group }: { group: ProjectGroup }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const draft = useNewSessionDraft();

    const sessionPath = group.path || '';
    const isWorktree = isWorktreePath(sessionPath);
    const repoPath = isWorktree ? getRepoPath(sessionPath) : sessionPath;
    const repoDisplayPath = isWorktree
        ? formatPathRelativeToHome(repoPath, group.homeDir ?? undefined)
        : group.displayPath;
    const worktreeName = isWorktree ? getWorktreeName(sessionPath) : null;

    const gitInfo = useSectionGitInfo(group.gitSessionId);
    const branchName = worktreeName || gitInfo.branch;
    const hasBranch = !!branchName;

    const handleAdd = React.useCallback(() => {
        if (group.machineId) {
            draft.setMachineId(group.machineId);
        }
        const pathToSet = formatPathRelativeToHome(repoPath, group.homeDir ?? undefined);
        draft.setPath(pathToSet);
        draft.setSessionType(isWorktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(isWorktree ? sessionPath : null);
        router.navigate('/new');
    }, [group.machineId, group.homeDir, repoPath, isWorktree, sessionPath, draft, router]);

    const [isHovered, setIsHovered] = React.useState(false);

    return (
        <View
            style={hasBranch ? styles.sectionHeader : styles.sectionHeaderSingleLine}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Path + branch — full (home-relative) path; long ones ellipsize
                in the middle so both the root and the leaf folder stay visible. */}
            <View style={styles.sectionHeaderContent}>
                <Text style={styles.sectionHeaderPath} numberOfLines={1} ellipsizeMode="middle">
                    {repoDisplayPath}
                </Text>
                {hasBranch && (
                    <View style={styles.branchRow}>
                        <Text style={styles.branchText} numberOfLines={1}>
                            {branchName}
                        </Text>
                        {isWorktree && (
                            <Ionicons
                                name="git-branch-outline"
                                size={11}
                                color={theme.colors.textSecondary}
                                style={styles.worktreeIcon}
                            />
                        )}
                        {gitInfo.linesAdded > 0 && (
                            <Text style={styles.addedText}>+{gitInfo.linesAdded}</Text>
                        )}
                        {gitInfo.linesRemoved > 0 && (
                            <Text style={styles.removedText}>-{gitInfo.linesRemoved}</Text>
                        )}
                    </View>
                )}
            </View>

            {/* + button — vertically centered, large hit area; desktop: hover-only */}
            <Pressable
                onPress={handleAdd}
                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                style={[styles.addButton, { opacity: Platform.OS !== 'web' || isHovered ? 1 : 0 }]}
            >
                <Ionicons name="add-outline" size={14} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

// Full-width separator between machine groups: ——— 🖥 name ———
const MachineSeparator = React.memo(({ machineName, machineId }: { machineName: string; machineId: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();

    const handlePress = React.useCallback(() => {
        router.navigate(`/machine/${machineId}` as any);
    }, [router, machineId]);

    return (
        <Pressable onPress={handlePress} style={styles.machineSeparator} hitSlop={{ top: 8, bottom: 8 }}>
            <View style={styles.machineSeparatorLine} />
            <Ionicons name="desktop-outline" size={11} color={theme.colors.textSecondary} style={{ marginHorizontal: 6 }} />
            <Text style={styles.machineSeparatorText} numberOfLines={1}>
                {machineName}
            </Text>
            <View style={styles.machineSeparatorLine} />
        </Pressable>
    );
});

export function ActiveSessionsGroupCompact({ sessions, selectedSessionId, terminals }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const machines = useAllMachines();
    // Optimistically hide a terminal the instant it's killed, instead of
    // waiting for the next 6s poll to drop it.
    const [removedTerminals, setRemovedTerminals] = React.useState<Set<string>>(() => new Set());
    const removeTerminal = React.useCallback((machineId: string, id: string) => {
        setRemovedTerminals((prev) => new Set(prev).add(`${machineId}:${id}`));
    }, []);

    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions AND terminals by machine, then by project within each.
    const { machineGroups, hasMultipleMachines } = React.useMemo(() => {
        const unknownText = t('status.unknown');
        const byMachine = new Map<string, {
            machineId: string;
            machineName: string;
            projects: Map<string, ProjectGroup>;
        }>();

        const ensureMachine = (machineId: string) => {
            const machine = machineId !== unknownText ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== unknownText ? machineId : `<${unknownText}>`);
            let machineGroup = byMachine.get(machineId);
            if (!machineGroup) {
                machineGroup = { machineId, machineName, projects: new Map() };
                byMachine.set(machineId, machineGroup);
            }
            return machineGroup;
        };

        const ensureProject = (machineGroup: { projects: Map<string, ProjectGroup> }, machineId: string, path: string, homeDir: string | null) => {
            let projectGroup = machineGroup.projects.get(path);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(path, homeDir ?? undefined);
                projectGroup = { path, displayPath, homeDir, machineId, gitSessionId: null, lastActivity: 0, sessions: [], terminals: [] };
                machineGroup.projects.set(path, projectGroup);
            }
            return projectGroup;
        };

        sessions.forEach(session => {
            const machineId = session.machineId || unknownText;
            const machineGroup = ensureMachine(machineId);
            const projectGroup = ensureProject(machineGroup, machineId, session.path || '', session.homeDir);
            projectGroup.sessions.push(session);
            projectGroup.lastActivity = Math.max(projectGroup.lastActivity, session.createdAt ?? 0);
            if (!projectGroup.gitSessionId) projectGroup.gitSessionId = session.id;
        });

        // Fold terminals into the same machine→project groups (matched by cwd).
        (terminals ?? []).forEach(group => {
            const machineGroup = ensureMachine(group.machineId);
            const homeDir = machinesMap[group.machineId]?.metadata?.homeDir ?? null;
            group.terminals.forEach(term => {
                if (removedTerminals.has(`${group.machineId}:${term.id}`)) return;
                const path = term.cwd || ` term:${term.id}`; // terminals without cwd get their own group
                const projectGroup = ensureProject(machineGroup, group.machineId, path, homeDir);
                projectGroup.terminals.push(term);
                projectGroup.lastActivity = Math.max(projectGroup.lastActivity, term.createdAt ?? 0);
            });
        });

        // Sort sessions/terminals within each project group
        byMachine.forEach(mg => {
            mg.projects.forEach(pg => {
                pg.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
                pg.terminals.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            });
        });

        // Machine groups sort by their most-recent project; projects within a
        // machine by recency too — most recently active bubbles to the top.
        const sorted = Array.from(byMachine.values()).map(mg => {
            const projectsSorted = Array.from(mg.projects.values()).sort((a, b) => b.lastActivity - a.lastActivity);
            const lastActivity = projectsSorted.reduce((m, p) => Math.max(m, p.lastActivity), 0);
            return { machineId: mg.machineId, machineName: mg.machineName, projectsSorted, lastActivity };
        }).sort((a, b) => b.lastActivity - a.lastActivity);

        return { machineGroups: sorted, hasMultipleMachines: byMachine.size > 1 };
    }, [sessions, terminals, machinesMap, removedTerminals]);

    return (
        <View style={styles.container}>
            {machineGroups.map(machineGroup => {
                const sortedProjects = machineGroup.projectsSorted;

                return (
                    <React.Fragment key={machineGroup.machineId}>
                        {hasMultipleMachines && (
                            <MachineSeparator
                                machineName={machineGroup.machineName}
                                machineId={machineGroup.machineId}
                            />
                        )}
                        {sortedProjects.map((projectGroup) => {
                            const rowCount = projectGroup.sessions.length + projectGroup.terminals.length;
                            let rowIndex = 0;
                            return (
                                <View key={projectGroup.path}>
                                    <SectionHeader group={projectGroup} />
                                    <View style={styles.projectCard}>
                                        {projectGroup.sessions.map((session) => {
                                            const i = rowIndex++;
                                            return (
                                                <CompactSessionRow
                                                    key={session.id}
                                                    session={session}
                                                    selected={selectedSessionId === session.id}
                                                    showBorder={i < rowCount - 1}
                                                />
                                            );
                                        })}
                                        {projectGroup.terminals.map((term) => {
                                            const i = rowIndex++;
                                            return (
                                                <CompactTerminalRow
                                                    key={`term:${term.id}`}
                                                    machineId={projectGroup.machineId}
                                                    terminal={term}
                                                    showBorder={i < rowCount - 1}
                                                    onRemoved={removeTerminal}
                                                />
                                            );
                                        })}
                                    </View>
                                </View>
                            );
                        })}
                    </React.Fragment>
                );
            })}
        </View>
    );
}

// Compact session row with status dot indicator
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: SessionRowData; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const baseStatus = getStatusConfig(theme)[session.state];
    // Override to solid accent when session has unread results
    const status = session.hasUnread
        ? { ...baseStatus, color: theme.colors.status.connected, kind: 'connected' as StatusDotKind, accessibilityLabel: t('status.connected'), isConnected: baseStatus.isConnected }
        : baseStatus;
    const navigateToSession = useNavigateToSession();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const [archivingSession, performArchive] = useHappyAction(async () => {
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
    });

    const handleArchive = React.useCallback(() => {
        swipeableRef.current?.close();
        performArchive();
    }, [performArchive]);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    // Cmd-held quick-switch number badge (web only).
    const commandHeld = useCommandKeyHeld();
    const quickSwitch = useSessionQuickSwitchMap();
    const quickSwitchNumber = quickSwitch.byId[session.id];
    const showQuickSwitchBadge = commandHeld && quickSwitchNumber != null;

    const renderLeadingIndicator = () => {
        let indicator: React.ReactNode = null;

        if (session.hasUnread) {
            indicator = <StatusDot kind="connected" accessibilityLabel={t('status.connected')} />;
        } else if (session.state === 'waiting' && session.hasDraft) {
            indicator = (
                <Ionicons
                    name="create-outline"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            );
        } else if (session.state === 'permission_required' || session.state === 'thinking') {
            indicator = <StatusDot kind={status.kind} accessibilityLabel={status.accessibilityLabel} />;
        } else if (session.state === 'waiting') {
            const waiting = getStatusConfig(theme).waiting;
            indicator = <StatusDot kind={waiting.kind} accessibilityLabel={waiting.accessibilityLabel} />;
        }

        return (
            <View style={styles.leadingIndicatorSlot}>
                {indicator}
            </View>
        );
    };

    const itemContent = (
        <Pressable
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected
            ]}
            onPress={handlePress}
            {...menuProps}
        >
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    {renderLeadingIndicator()}

                    <Text
                        style={[
                            styles.sessionTitle,
                            status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                        ]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                    >
                        {session.name}
                    </Text>
                    {showQuickSwitchBadge && <QuickSwitchBadge number={quickSwitchNumber} />}
                </View>
            </View>
        </Pressable>
    );

    if (!swipeEnabled) {
        return (
            <>
                {itemContent}
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                />
            </>
        );
    }

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeAction}
            onPress={handleArchive}
            disabled={archivingSession}
        >
            <Ionicons name="archive-outline" size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText} numberOfLines={2}>
                {t('sessionInfo.archiveSession')}
            </Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={renderRightActions}
            overshootRight={false}
            enabled={!archivingSession}
        >
            {itemContent}
        </Swipeable>
    );
});

function terminalTitle(term: MachineTerminal): string {
    if (term.title && term.title.trim()) return term.title.trim();
    if (term.cwd) {
        const segs = term.cwd.replace(/\\/g, '/').split('/').filter(Boolean);
        if (segs.length) return segs[segs.length - 1];
    }
    return term.id;
}

// Terminal row — same anatomy as a session row, but with a mono "$" glyph in
// the leading slot so a live tmux session reads as part of the same list.
const CompactTerminalRow = React.memo(({ machineId, terminal, showBorder, onRemoved }: {
    machineId: string;
    terminal: MachineTerminal;
    showBorder?: boolean;
    onRemoved: (machineId: string, id: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ tid?: string }>();

    const title = terminalTitle(terminal);
    const selected = pathname === `/terminal/web/${machineId}` && params.tid === terminal.id;

    const handlePress = React.useCallback(() => {
        router.push(`/terminal/web/${machineId}?tid=${terminal.id}` as any);
    }, [router, machineId, terminal.id]);

    const menu = React.useCallback(() => {
        Modal.alert(title, undefined, [
            {
                text: t('common.rename'),
                onPress: async () => {
                    const next = await Modal.prompt(t('common.rename'), undefined, { defaultValue: title });
                    if (next && next.trim()) void machineSetTerminalTitle(machineId, terminal.id, next.trim());
                },
            },
            {
                text: t('common.delete'),
                style: 'destructive',
                onPress: () => {
                    onRemoved(machineId, terminal.id);
                    void machineKillTerminal(machineId, terminal.id);
                },
            },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [title, machineId, terminal.id, onRemoved]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        menu();
    }, [menu]);

    return (
        <Pressable
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected,
            ]}
            onPress={handlePress}
            onLongPress={menu}
            // @ts-ignore - web only
            onContextMenu={Platform.OS === 'web' ? handleContextMenu : undefined}
        >
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    <View style={styles.leadingIndicatorSlot}>
                        <Text style={[styles.terminalGlyph, { color: theme.colors.textSecondary }]}>$</Text>
                    </View>
                    <Text style={[styles.sessionTitle, styles.terminalTitle]} numberOfLines={1}>
                        {title}
                    </Text>
                    <Pressable hitSlop={8} style={styles.terminalKebab} onPress={menu}>
                        <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>
        </Pressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 4,
    },
    // Section header styles
    sectionHeader: {
        paddingTop: 8,
        paddingBottom: Platform.select({ ios: 6, default: 4 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 12 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderSingleLine: {
        paddingTop: 8,
        paddingBottom: Platform.select({ ios: 6, default: 4 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 12 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderContent: {
        flex: 1,
        justifyContent: 'center',
        minWidth: 0,
    },
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        flexShrink: 1,
    },
    branchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 1,
    },
    branchText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        flexShrink: 1,
    },
    worktreeIcon: {
        marginLeft: 4,
    },
    addedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
        marginLeft: 6,
    },
    removedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
        marginLeft: 3,
    },
    addButton: {
        marginLeft: 4,
        padding: 8,
    },
    // Machine separator styles
    machineSeparator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 8,
        paddingBottom: 0,
    },
    machineSeparatorLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    machineSeparatorText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        marginRight: 4,
    },
    // Project card styles
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: Platform.select({ ios: 8, default: 6 }),
        marginHorizontal: Platform.select({ ios: 16, default: 8 }),
        borderRadius: Platform.select({ ios: 10, default: 8 }),
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    // Session row styles — compact single-line rows (desktop-client density).
    sessionRow: {
        height: Platform.select({ ios: 56, default: 38 }),
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface,
    },
    sessionRowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionTitle: {
        fontSize: 15,
        flex: 1,
        ...Typography.default('regular'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    leadingIndicatorSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        marginRight: 8,
    },
    terminalGlyph: {
        ...Typography.mono('semiBold'),
        fontSize: 13,
        lineHeight: 16,
    },
    terminalTitle: {
        ...Typography.mono(),
        fontSize: 13,
        color: theme.colors.text,
    },
    terminalKebab: {
        padding: 4,
        borderRadius: 6,
        marginLeft: 4,
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: '#FFFFFF',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
}));
