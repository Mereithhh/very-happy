/**
 * Settings → Voice (B-051): assistant TTS voice, read-aloud policy, and the
 * assistant host machine.
 *
 * Deliberately a SEPARATE file: SettingsRoutes.tsx is a declared conflict
 * hot-zone — it only gains an import, one <Route> line and one overview
 * <Item>. The Page/Header shells are re-implemented here on the same set-*
 * CSS classes rather than exported from the hot file.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Switch from '@radix-ui/react-switch';
import { Play, Check, Server } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { ItemList, ItemGroup, Item, Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useAuth } from '@/auth/AuthContext';
import { useSettingMutable, useAllMachines } from '@/sync/storage';
import { fetchTtsVoices, type TtsVoice } from '@/sync/apiVoice';
import { machineLabel } from '@/utils/machineUtils';

function Page({ children }: { children: ReactNode }) {
    return (
        <div className="set-scroll" style={{ height: '100dvh' }}>
            <div className="set-page">{children}</div>
        </div>
    );
}

function Header({ title }: { title: string }) {
    return (
        <div className="set-header">
            <BackButton />
            <div className="set-header__titles">
                <span className="set-header__title">{title}</span>
            </div>
        </div>
    );
}

type VoicesState =
    | { kind: 'loading' }
    | { kind: 'ok'; voices: TtsVoice[] }
    | { kind: 'unavailable' };

export function VoiceSettings() {
    const { t } = useTranslation();
    const { credentials } = useAuth();

    const [voiceId, setVoiceId] = useSettingMutable('voiceTtsVoiceId');
    const [readTextReplies, setReadTextReplies] = useSettingMutable('voiceReadTextReplies');
    const [assistantMachineId, setAssistantMachineId] = useSettingMutable('assistantMachineId');
    const [skipPermissions, setSkipPermissions] = useSettingMutable('assistantSkipPermissions');
    const machines = useAllMachines({ includeOffline: true });

    // ── voices list (graceful 404/501 degrade, errors consumed locally) ──
    const [voicesState, setVoicesState] = useState<VoicesState>({ kind: 'loading' });
    useEffect(() => {
        if (!credentials) return;
        let cancelled = false;
        void fetchTtsVoices(credentials).then((res) => {
            if (cancelled) return;
            if (res.kind === 'ok') setVoicesState({ kind: 'ok', voices: res.voices });
            else setVoicesState({ kind: 'unavailable' });
        });
        return () => {
            cancelled = true;
        };
    }, [credentials]);

    // ── preview playback (settings click = user gesture, plain Audio is fine) ──
    const previewRef = useRef<HTMLAudioElement | null>(null);
    const [previewingId, setPreviewingId] = useState<string | null>(null);
    const onPreview = (voice: TtsVoice) => {
        if (!voice.previewUrl) return;
        previewRef.current?.pause();
        const audio = new Audio(voice.previewUrl);
        previewRef.current = audio;
        setPreviewingId(voice.voiceId);
        audio.onended = () => setPreviewingId((cur) => (cur === voice.voiceId ? null : cur));
        void audio.play().catch(() => setPreviewingId(null));
    };
    useEffect(() => {
        return () => previewRef.current?.pause();
    }, []);

    return (
        <Page>
            <Header title={t('settingsVoice.title')} />
            <ItemList>
                <ItemGroup title={t('settingsVoice.voice')}>
                    {voicesState.kind === 'loading' && (
                        <Item title={t('common.loading')} left={<Spinner size={16} />} />
                    )}
                    {voicesState.kind === 'unavailable' && (
                        <Item title={t('settingsVoice.voicesUnavailable')} />
                    )}
                    {voicesState.kind === 'ok' && (
                        <>
                            <Item
                                title={t('settingsVoice.voiceDefault')}
                                right={voiceId == null ? <Check size={16} /> : undefined}
                                onClick={() => setVoiceId(null)}
                            />
                            {voicesState.voices.map((voice) => (
                                <Item
                                    key={voice.voiceId}
                                    title={voice.name}
                                    subtitle={voice.labels ? Object.values(voice.labels).join(' · ') : undefined}
                                    left={
                                        voice.previewUrl ? (
                                            <button
                                                type="button"
                                                className="set-header__back"
                                                aria-label={t('settingsVoice.preview')}
                                                title={t('settingsVoice.preview')}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onPreview(voice);
                                                }}
                                            >
                                                {previewingId === voice.voiceId ? (
                                                    <Spinner size={14} />
                                                ) : (
                                                    <Play size={14} />
                                                )}
                                            </button>
                                        ) : undefined
                                    }
                                    right={voiceId === voice.voiceId ? <Check size={16} /> : undefined}
                                    onClick={() => setVoiceId(voice.voiceId)}
                                />
                            ))}
                        </>
                    )}
                </ItemGroup>

                <ItemGroup>
                    <Item
                        title={t('settingsVoice.readTextReplies')}
                        subtitle={t('settingsVoice.readTextRepliesHint')}
                        right={
                            <Switch.Root
                                className="set-switch"
                                checked={readTextReplies}
                                onCheckedChange={setReadTextReplies}
                                aria-label={t('settingsVoice.readTextReplies')}
                            >
                                <Switch.Thumb className="set-switch__thumb" />
                            </Switch.Root>
                        }
                    />
                    <Item
                        title={t('settingsVoice.skipPermissions')}
                        subtitle={t('settingsVoice.skipPermissionsHint')}
                        right={
                            <Switch.Root
                                className="set-switch"
                                checked={skipPermissions}
                                onCheckedChange={setSkipPermissions}
                                aria-label={t('settingsVoice.skipPermissions')}
                            >
                                <Switch.Thumb className="set-switch__thumb" />
                            </Switch.Root>
                        }
                    />
                </ItemGroup>

                <ItemGroup title={t('settingsVoice.assistantMachine')}>
                    <Item
                        title={t('settingsVoice.assistantMachineAuto')}
                        right={assistantMachineId == null ? <Check size={16} /> : undefined}
                        onClick={() => setAssistantMachineId(null)}
                    />
                    {machines.map((machine) => (
                        <Item
                            key={machine.id}
                            title={machineLabel(machine)}
                            subtitle={machine.active ? 'online' : 'offline'}
                            left={<Server size={16} />}
                            right={assistantMachineId === machine.id ? <Check size={16} /> : undefined}
                            onClick={() => setAssistantMachineId(machine.id)}
                        />
                    ))}
                </ItemGroup>
            </ItemList>
        </Page>
    );
}
