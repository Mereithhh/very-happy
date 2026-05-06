import * as React from 'react';
import { View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSession, useSessionMessages } from '@/sync/storage';
import { useHappyAction } from '@/hooks/useHappyAction';
import { forkAndSpawn, type ForkSource } from '@/sync/ops';
import type { Message } from '@/sync/typesMessage';

export interface DuplicateSheetProps {
    sessionId: string;
    /** Pre-select this message id when the sheet opens (long-press entry). */
    initialMessageId?: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

/**
 * Picker for "duplicate session from message N". Shows the user-text
 * messages in reverse order; tap to choose the rewind point, confirm to
 * fork and spawn a new Happy session truncated at that message.
 *
 * Older messages without an attached `claudeUuid` are visibly disabled —
 * we cannot guarantee a precise on-disk truncation point for them.
 */
export const DuplicateSheet = React.memo(function DuplicateSheet(props: DuplicateSheetProps) {
    const { sessionId, initialMessageId, onClose } = props;
    const session = useSession(sessionId);
    const { messages } = useSessionMessages(sessionId);
    const router = useRouter();

    const userMessages = React.useMemo(() => {
        const filtered = messages.filter((m): m is Extract<Message, { kind: 'user-text' }> =>
            m.kind === 'user-text' && (m.text ?? '').trim().length > 0,
        );
        // Newest first — easier to find a recent rewind point.
        return [...filtered].reverse();
    }, [messages]);

    const [selectedId, setSelectedId] = React.useState<string | null>(initialMessageId ?? null);

    // If the initial message id was provided but isn't in the eligible list,
    // clear the selection so the user is forced to pick a valid one.
    React.useEffect(() => {
        if (selectedId && !userMessages.some((m) => m.id === selectedId)) {
            setSelectedId(null);
        }
    }, [selectedId, userMessages]);

    const machineId = session?.metadata?.machineId;
    const directory = session?.metadata?.path;
    const claudeSessionId = session?.metadata?.claudeSessionId;

    const canFork =
        Boolean(session) &&
        Boolean(machineId) &&
        Boolean(directory) &&
        Boolean(claudeSessionId) &&
        session?.metadata?.flavor !== 'codex' &&
        session?.metadata?.flavor !== 'gemini';

    const selected = selectedId ? userMessages.find((m) => m.id === selectedId) ?? null : null;
    const selectedClaudeUuid = selected?.claudeUuid;

    const [loading, doDuplicate] = useHappyAction(async () => {
        if (!canFork || !machineId || !directory || !claudeSessionId) {
            Modal.alert(t('common.error'), t('session.forkErrorMissingMetadata'));
            return;
        }
        if (!selected || !selectedClaudeUuid) {
            Modal.alert(t('common.error'), t('session.duplicateRowDisabled'));
            return;
        }

        const source: ForkSource = {
            sessionId,
            machineId,
            directory,
            claudeSessionId,
        };
        const result = await forkAndSpawn(source, {
            truncateBeforeUuid: selectedClaudeUuid,
            forkedFromMessageId: selected.id,
        });

        if (result.type === 'success') {
            onClose?.();
            router.replace(`/session/${result.sessionId}`);
            return;
        }

        const message = result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric');
        Modal.alert(t('common.error'), message);
    });

    return (
        <View style={styles.sheet}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('session.duplicateSheetTitle')}</Text>
                <Text style={styles.subtitle}>{t('session.duplicateSheetSubtitle')}</Text>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {userMessages.length === 0 ? (
                    <Text style={styles.emptyText}>{t('session.duplicateSheetEmpty')}</Text>
                ) : (
                    userMessages.map((msg) => {
                        const hasUuid = Boolean(msg.claudeUuid);
                        const isSelected = msg.id === selectedId;
                        const preview = (msg.displayText ?? msg.text).trim().replace(/\s+/g, ' ');
                        const truncated = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
                        const subtitleText = hasUuid
                            ? formatRelativeTime(msg.createdAt)
                            : t('session.duplicateRowDisabled');

                        return (
                            <Pressable
                                key={msg.id}
                                onPress={hasUuid ? () => setSelectedId(msg.id) : undefined}
                                style={({ pressed }) => [
                                    styles.row,
                                    isSelected && styles.rowSelected,
                                    !hasUuid && styles.rowDisabled,
                                    pressed && hasUuid && styles.rowPressed,
                                ]}
                                disabled={!hasUuid}
                            >
                                <Text
                                    style={[styles.rowText, !hasUuid && styles.rowTextDisabled]}
                                    numberOfLines={3}
                                >
                                    {truncated}
                                </Text>
                                <Text style={[styles.rowMeta, !hasUuid && styles.rowMetaDisabled]}>
                                    {subtitleText}
                                </Text>
                            </Pressable>
                        );
                    })
                )}
            </ScrollView>

            <View style={styles.actions}>
                <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={doDuplicate}
                    disabled={loading || !selected || !selectedClaudeUuid || !canFork}
                    style={({ pressed }) => [
                        styles.button,
                        styles.buttonPrimary,
                        (loading || !selected || !selectedClaudeUuid || !canFork) && styles.buttonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.buttonPrimaryText}>
                        {loading ? t('common.loading') : t('session.duplicateSheetConfirm')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
});

function formatRelativeTime(timestampMs: number): string {
    const diffMs = Date.now() - timestampMs;
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return t('time.justNow');
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    const days = Math.floor(hours / 24);
    return t('time.daysAgo', { count: days });
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        width: '100%',
        maxWidth: 560,
        maxHeight: '85%',
        overflow: 'hidden',
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    list: {
        flexGrow: 0,
        flexShrink: 1,
        maxHeight: 420,
    },
    listContent: {
        paddingVertical: 8,
    },
    emptyText: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        paddingVertical: 32,
        paddingHorizontal: 20,
        fontSize: 14,
    },
    row: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowDisabled: {
        opacity: 0.5,
    },
    rowText: {
        fontSize: 14,
        color: theme.colors.text,
        lineHeight: 19,
    },
    rowTextDisabled: {
        color: theme.colors.textSecondary,
    },
    rowMeta: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    rowMetaDisabled: {
        color: theme.colors.textSecondary,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        padding: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    button: {
        flex: 1,
        paddingVertical: Platform.select({ ios: 11, default: 12 }),
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    buttonPrimaryText: {
        color: theme.colors.button.primary.tint,
        fontSize: 15,
        fontWeight: '600' as const,
    },
    buttonSecondaryText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '500' as const,
    },
}));
