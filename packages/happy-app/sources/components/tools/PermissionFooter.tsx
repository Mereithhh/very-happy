import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { t } from '@/text';

interface PermissionFooterProps {
    permission: {
        id: string;
        status: "pending" | "approved" | "denied" | "canceled";
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    };
    sessionId: string;
    toolName: string;
    toolInput?: any;
    metadata?: any;
}

export const PermissionFooter: React.FC<PermissionFooterProps> = ({ permission, sessionId, toolName, toolInput, metadata }) => {
    const { theme } = useUnistyles();
    const [loadingButton, setLoadingButton] = useState<'allow' | 'deny' | 'abort' | null>(null);
    const [loadingAllEdits, setLoadingAllEdits] = useState(false);
    const [loadingBypass, setLoadingBypass] = useState(false);
    const [loadingForSession, setLoadingForSession] = useState(false);
    
    // Check if this is a Codex session - check both metadata.flavor and tool name prefix
    const isCodex = metadata?.flavor === 'codex' || toolName.startsWith('Codex');

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingButton('allow');
        try {
            await sessionAllow(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };

    const handleApproveAllEdits = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingAllEdits(true);
        try {
            await sessionAllow(sessionId, permission.id, 'acceptEdits');
            // Update the session permission mode to 'acceptEdits' for future permissions
            storage.getState().updateSessionPermissionMode(sessionId, 'acceptEdits');
        } catch (error) {
            console.error('Failed to approve all edits:', error);
        } finally {
            setLoadingAllEdits(false);
        }
    };

    const handleBypassPermissions = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingBypass(true);
        try {
            await sessionAllow(sessionId, permission.id, 'bypassPermissions');
            storage.getState().updateSessionPermissionMode(sessionId, 'bypassPermissions');
        } catch (error) {
            console.error('Failed to bypass permissions:', error);
        } finally {
            setLoadingBypass(false);
        }
    };

    const handleApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession || !toolName) return;

        setLoadingForSession(true);
        try {
            // Special handling for Bash tool - include exact command
            let toolIdentifier = toolName;
            if (toolName === 'Bash' && toolInput?.command) {
                const command = toolInput.command;
                toolIdentifier = `Bash(${command})`;
            }
            
            await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingButton('deny');
        try {
            await sessionDeny(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    // Codex-specific handlers
    const handleCodexApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession) return;
        
        setLoadingButton('allow');
        try {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved');
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    const handleCodexApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession) return;
        
        setLoadingForSession(true);
        try {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved_for_session');
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };
    
    const handleCodexAbort = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession) return;
        
        setLoadingButton('abort');
        try {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'abort');
        } catch (error) {
            console.error('Failed to abort permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };

    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isPending = permission.status === 'pending';

    // Helper function to check if tool matches allowed pattern
    const isToolAllowed = (toolName: string, toolInput: any, allowedTools: string[] | undefined): boolean => {
        if (!allowedTools) return false;
        
        // Direct match for non-Bash tools
        if (allowedTools.includes(toolName)) return true;
        
        // For Bash, check exact command match
        if (toolName === 'Bash' && toolInput?.command) {
            const command = toolInput.command;
            return allowedTools.includes(`Bash(${command})`);
        }
        
        return false;
    };

    // Detect which button was used based on mode (for Claude) or decision (for Codex)
    const isApprovedViaAllow = isApproved && permission.mode !== 'acceptEdits' && permission.mode !== 'bypassPermissions' && !isToolAllowed(toolName, toolInput, permission.allowedTools);
    const isApprovedViaAllEdits = isApproved && permission.mode === 'acceptEdits';
    const isApprovedViaBypass = isApproved && permission.mode === 'bypassPermissions';
    const isApprovedForSession = isApproved && isToolAllowed(toolName, toolInput, permission.allowedTools);
    
    // Codex-specific status detection with fallback
    const isCodexApproved = isCodex && isApproved && (permission.decision === 'approved' || !permission.decision);
    const isCodexApprovedForSession = isCodex && isApproved && permission.decision === 'approved_for_session';
    const isCodexAborted = isCodex && isDenied && permission.decision === 'abort';

    // Primary accent used for the prominent Approve button — reuse the theme's
    // dedicated allow-button colours so it matches the rest of the app.
    const accent = (theme.colors as any).permissionButton?.allow?.background
        ?? (theme.colors as any).permission?.approve
        ?? theme.colors.success
        ?? theme.colors.text;
    const accentText = (theme.colors as any).permissionButton?.allow?.text ?? theme.colors.button.primary.tint;

    const styles = StyleSheet.create({
        container: {
            paddingHorizontal: 4,
            paddingTop: 6,
            paddingBottom: 6,
            justifyContent: 'center',
            gap: 8,
        },
        // Prominent primary row: the big Approve button is the obvious action.
        primaryRow: {
            flexDirection: 'row',
            alignItems: 'stretch',
            gap: 8,
        },
        // Secondary options wrap below (Allow all edits / for tool / bypass / deny).
        secondaryRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
        },
        // Big, filled, hard-to-miss approve button.
        primaryButton: {
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 44,
            borderRadius: 10,
            backgroundColor: accent,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 16,
            borderWidth: 1,
            borderColor: accent,
        },
        primaryButtonText: {
            fontSize: 16,
            fontWeight: '700',
            color: accentText,
        },
        // Compact deny sits next to approve on the primary row.
        denyButton: {
            flexShrink: 0,
            minHeight: 44,
            minWidth: 88,
            borderRadius: 10,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 14,
            borderWidth: 1,
            borderColor: theme.colors.textSecondary,
        },
        denyButtonText: {
            fontSize: 15,
            fontWeight: '600',
            color: theme.colors.text,
        },
        // Legacy-style small secondary options.
        button: {
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 34,
            maxWidth: '100%',
            borderWidth: 1,
            borderColor: theme.colors.textSecondary,
            flexShrink: 1,
            opacity: 0.78,
        },
        buttonAllow: {
            borderColor: theme.colors.textSecondary,
        },
        buttonDeny: {
            borderColor: theme.colors.textSecondary,
        },
        buttonAllowAll: {
            borderColor: theme.colors.textSecondary,
        },
        buttonSelected: {
            backgroundColor: 'transparent',
            borderColor: theme.colors.textSecondary,
            opacity: 1,
        },
        buttonInactive: {
            opacity: 0.5,
        },
        buttonContent: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            minHeight: 16,
            minWidth: 0,
        },
        icon: {
            marginRight: 2,
        },
        buttonText: {
            fontSize: 13,
            fontWeight: '400',
            color: theme.colors.text,
        },
        buttonTextAllow: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextDeny: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextAllowAll: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextSelected: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonForSession: {
            borderColor: theme.colors.textSecondary,
        },
        buttonTextForSession: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        // Selected/inactive states for the prominent primary + deny buttons.
        primaryButtonInactive: {
            opacity: 0.45,
        },
        primaryButtonSelected: {
            opacity: 1,
        },
        denyButtonSelected: {
            borderColor: theme.colors.textDestructive ?? theme.colors.text,
            opacity: 1,
        },
        loadingIndicatorAllow: {
            color: theme.colors.text,
        },
        loadingIndicatorDeny: {
            color: theme.colors.text,
        },
        loadingIndicatorAllowAll: {
            color: theme.colors.text,
        },
        loadingIndicatorForSession: {
            color: theme.colors.text,
        },
        iconApproved: {
            color: theme.colors.text,
        },
        iconDenied: {
            color: theme.colors.text,
        },
    });

    // Render Codex buttons if this is a Codex session
    if (isCodex) {
        return (
            <View style={styles.container}>
                {/* Prominent primary row: big Yes + compact Stop */}
                <View style={styles.primaryRow}>
                    <TouchableOpacity
                        style={[
                            styles.primaryButton,
                            isCodexApproved && styles.primaryButtonSelected,
                            (isCodexAborted || isCodexApprovedForSession) && styles.primaryButtonInactive
                        ]}
                        onPress={handleCodexApprove}
                        disabled={!isPending || loadingButton !== null || loadingForSession}
                        activeOpacity={isPending ? 0.85 : 1}
                    >
                        {loadingButton === 'allow' && isPending ? (
                            <ActivityIndicator size="small" color={accentText} />
                        ) : (
                            <Text style={styles.primaryButtonText} numberOfLines={1} ellipsizeMode="tail">
                                {t('common.yes')}
                            </Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[
                            styles.denyButton,
                            isCodexAborted && styles.denyButtonSelected,
                            (isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleCodexAbort}
                        disabled={!isPending || loadingButton !== null || loadingForSession}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingButton === 'abort' && isPending ? (
                            <ActivityIndicator size="small" color={styles.loadingIndicatorDeny.color} />
                        ) : (
                            <Text style={styles.denyButtonText} numberOfLines={1} ellipsizeMode="tail">
                                {t('codex.permissions.stopAndExplain')}
                            </Text>
                        )}
                    </TouchableOpacity>
                </View>

                {/* Secondary option: yes for the whole session */}
                <View style={styles.secondaryRow}>
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isCodexApprovedForSession && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved) && styles.buttonInactive
                        ]}
                        onPress={handleCodexApproveForSession}
                        disabled={!isPending || loadingButton !== null || loadingForSession}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSession && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isCodexApprovedForSession && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('codex.permissions.yesForSession')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // Render Claude buttons (existing behavior)
    return (
        <View style={styles.container}>
            {/* Prominent primary row: big Approve + compact Deny. This is the
                fast-path one-tap action for remote/mobile approvals. */}
            <View style={styles.primaryRow}>
                <TouchableOpacity
                    style={[
                        styles.primaryButton,
                        isApprovedViaAllow && styles.primaryButtonSelected,
                        (isDenied || isApprovedViaAllEdits || isApprovedViaBypass || isApprovedForSession) && styles.primaryButtonInactive
                    ]}
                    onPress={handleApprove}
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession}
                    activeOpacity={isPending ? 0.85 : 1}
                >
                    {loadingButton === 'allow' && isPending ? (
                        <ActivityIndicator size="small" color={accentText} />
                    ) : (
                        <Text style={styles.primaryButtonText} numberOfLines={1} ellipsizeMode="tail">
                            {t('claude.permissions.approve')}
                        </Text>
                    )}
                </TouchableOpacity>

                <TouchableOpacity
                    style={[
                        styles.denyButton,
                        isDenied && styles.denyButtonSelected,
                        isApproved && styles.buttonInactive
                    ]}
                    onPress={handleDeny}
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loadingButton === 'deny' && isPending ? (
                        <ActivityIndicator size="small" color={styles.loadingIndicatorDeny.color} />
                    ) : (
                        <Text style={styles.denyButtonText} numberOfLines={1} ellipsizeMode="tail">
                            {t('claude.permissions.deny')}
                        </Text>
                    )}
                </TouchableOpacity>
            </View>

            {/* Secondary options: broader-scope approvals + "no, with feedback". */}
            <View style={styles.secondaryRow}>
                {/* Allow All Edits button - only show for Edit and MultiEdit tools */}
                {(toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonAllowAll,
                            isApprovedViaAllEdits && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaBypass || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleApproveAllEdits}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingAllEdits && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllowAll.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowAll,
                                    isApprovedViaAllEdits && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesAllowAllEdits')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Bypass all permissions (yolo mode) - only show for ExitPlanMode */}
                {(toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedViaBypass && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleBypassPermissions}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingBypass && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isApprovedViaBypass && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesAllowEverything')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow for session button - only show for non-edit, non-exit-plan tools */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedForSession && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedViaBypass) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSession}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSession && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isApprovedForSession && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesForTool')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
};
