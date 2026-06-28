/**
 * Snippets settings — manage prompt presets (inserted into the chat composer)
 * and terminal quick commands (pasted into the web terminal). Both are synced
 * via Settings, so they follow the account across devices.
 */
import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { SnippetEditorModal } from '@/components/SnippetEditorModal';
import { t } from '@/text';

function genId(): string {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export default function SnippetsSettingsScreen() {
    const { theme } = useUnistyles();
    const [promptPresets, setPromptPresets] = useSettingMutable('promptPresets');
    const [terminalCommands, setTerminalCommands] = useSettingMutable('terminalCommands');

    const editPreset = React.useCallback((existing?: { id: string; title: string; text: string }) => {
        Modal.show({
            component: (props: any) => (
                <SnippetEditorModal
                    {...props}
                    heading={existing ? t('settingsSnippets.editPreset') : t('settingsSnippets.newPreset')}
                    bodyLabel="PROMPT"
                    bodyPlaceholder="例如:用审视的目光 review 这段代码,指出潜在问题…"
                    initialTitle={existing?.title}
                    initialBody={existing?.text}
                    onSave={(title: string, body: string) => {
                        setPromptPresets(
                            existing
                                ? promptPresets.map((p) => (p.id === existing.id ? { ...p, title, text: body } : p))
                                : [...promptPresets, { id: genId(), title, text: body }],
                        );
                    }}
                />
            ),
        });
    }, [promptPresets, setPromptPresets]);

    const editCommand = React.useCallback((existing?: { id: string; title: string; command: string }) => {
        Modal.show({
            component: (props: any) => (
                <SnippetEditorModal
                    {...props}
                    heading={existing ? t('settingsSnippets.editCommand') : t('settingsSnippets.newCommand')}
                    bodyLabel="COMMAND"
                    bodyMono
                    bodyPlaceholder="例如:git status"
                    initialTitle={existing?.title}
                    initialBody={existing?.command}
                    onSave={(title: string, body: string) => {
                        setTerminalCommands(
                            existing
                                ? terminalCommands.map((c) => (c.id === existing.id ? { ...c, title, command: body } : c))
                                : [...terminalCommands, { id: genId(), title, command: body }],
                        );
                    }}
                />
            ),
        });
    }, [terminalCommands, setTerminalCommands]);

    const deleteRow = React.useCallback(async (title: string, onConfirm: () => void) => {
        const ok = await Modal.confirm(t('settingsSnippets.deleteTitle'), title, { confirmText: t('settingsSnippets.deleteConfirm'), destructive: true });
        if (ok) onConfirm();
    }, []);

    const trash = (onPress: () => void) => (
        <Pressable onPress={onPress} hitSlop={10} style={{ padding: 4 }}>
            <Ionicons name="trash-outline" size={20} color={theme.colors.status.error} />
        </Pressable>
    );

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSnippets.presetsGroup')} footer={t('settingsSnippets.presetsFooter')}>
                {promptPresets.map((p) => (
                    <Item
                        key={p.id}
                        title={p.title || p.text.split('\n')[0]}
                        subtitle={p.text}
                        subtitleLines={2}
                        icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={trash(() => deleteRow(p.title || p.text.slice(0, 24), () => setPromptPresets(promptPresets.filter((x) => x.id !== p.id))))}
                        onPress={() => editPreset(p)}
                    />
                ))}
                <Item
                    title={t('settingsSnippets.addPreset')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.textLink} />}
                    onPress={() => editPreset()}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSnippets.commandsGroup')} footer={t('settingsSnippets.commandsFooter')}>
                {terminalCommands.map((c) => (
                    <Item
                        key={c.id}
                        title={c.title || c.command.split('\n')[0]}
                        subtitle={c.command}
                        subtitleLines={2}
                        icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={trash(() => deleteRow(c.title || c.command.slice(0, 24), () => setTerminalCommands(terminalCommands.filter((x) => x.id !== c.id))))}
                        onPress={() => editCommand(c)}
                    />
                ))}
                <Item
                    title={t('settingsSnippets.addCommand')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.textLink} />}
                    onPress={() => editCommand()}
                />
            </ItemGroup>
        </ItemList>
    );
}
