/**
 * Add / edit a snippet (a prompt preset or a terminal quick command). Two
 * fields — an optional title and the body — shown via `Modal.show`. The caller
 * passes the current values (for edit) and an onSave that persists to settings.
 */
import * as React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface SnippetEditorModalProps {
    heading: string;
    bodyLabel: string;
    bodyPlaceholder?: string;
    bodyMono?: boolean;
    initialTitle?: string;
    initialBody?: string;
    onSave: (title: string, body: string) => void;
    onClose?: () => void;
}

export function SnippetEditorModal({
    heading,
    bodyLabel,
    bodyPlaceholder,
    bodyMono,
    initialTitle = '',
    initialBody = '',
    onSave,
    onClose,
}: SnippetEditorModalProps) {
    const { theme } = useUnistyles();
    const [title, setTitle] = React.useState(initialTitle);
    const [body, setBody] = React.useState(initialBody);
    const canSave = body.trim().length > 0;

    const handleSave = () => {
        if (!canSave) return;
        // Fall back to the first line of the body as the title when blank.
        const finalTitle = title.trim() || body.trim().split('\n')[0].slice(0, 40);
        onSave(finalTitle, body.trim());
        onClose?.();
    };

    const inputBase = {
        color: theme.colors.text,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    };

    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.heading, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{heading}</Text>

            <Text style={[styles.label, { color: theme.colors.textSecondary, ...Typography.mono() }]}>{t('settingsSnippets.editorTitleLabel')}</Text>
            <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder={t('settingsSnippets.editorTitlePlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                style={[styles.input, inputBase, { ...Typography.default() }]}
            />

            <Text style={[styles.label, { color: theme.colors.textSecondary, ...Typography.mono() }]}>{bodyLabel}</Text>
            <TextInput
                value={body}
                onChangeText={setBody}
                placeholder={bodyPlaceholder}
                placeholderTextColor={theme.colors.textSecondary}
                multiline
                style={[styles.input, styles.bodyInput, inputBase, bodyMono ? Typography.mono() : Typography.default()]}
            />

            <View style={styles.actions}>
                <Pressable onPress={onClose} style={styles.btn} hitSlop={6}>
                    <Text style={[styles.btnText, { color: theme.colors.textSecondary, ...Typography.default() }]}>{t('settingsSnippets.editorCancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={handleSave}
                    disabled={!canSave}
                    style={[styles.btn, { backgroundColor: theme.colors.button.primary.background, opacity: canSave ? 1 : 0.5 }]}
                    hitSlop={6}
                >
                    <Text style={[styles.btnText, { color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }]}>{t('settingsSnippets.editorSave')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { width: '100%', maxWidth: 460, borderRadius: 16, padding: 20 },
    heading: { fontSize: 18, marginBottom: 14 },
    label: { fontSize: 11, letterSpacing: 1, marginBottom: 6, marginTop: 4 },
    input: {
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        marginBottom: 12,
    },
    bodyInput: { minHeight: 96, maxHeight: 220, textAlignVertical: 'top' },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
    btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    btnText: { fontSize: 14 },
});
