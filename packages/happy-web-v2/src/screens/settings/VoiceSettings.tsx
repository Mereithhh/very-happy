/**
 * Settings → Voice (B-051): assistant TTS voice, read-aloud policy, and the
 * assistant host machine.
 *
 * Deliberately a SEPARATE file: SettingsRoutes.tsx is a declared conflict
 * hot-zone — it only gains an import, one <Route> line and one overview
 * <Item>. The Page/Header shells are re-implemented here on the same set-*
 * CSS classes rather than exported from the hot file.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Switch from '@radix-ui/react-switch';
import { Play, Check, Server } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { ItemList, ItemGroup, Item, Spinner, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useAuth } from '@/auth/AuthContext';
import { useSettingMutable, useAllMachines } from '@/sync/storage';
import {
    addSharedVoice,
    fetchSharedVoices,
    fetchTtsVoices,
    type SharedVoice,
    type TtsVoice,
} from '@/sync/apiVoice';
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

// ── B-081 voice library (shared voices) ──
type LibraryState =
    | { kind: 'collapsed' }
    | { kind: 'loading' }
    | { kind: 'ok'; voices: SharedVoice[] }
    /** 404/501 — server not upgraded / voice not configured */
    | { kind: 'unavailable' }
    | { kind: 'error' };

// Must mirror the server's SHARED_VOICES_LANGS whitelist.
const LIBRARY_LANGS = [
    ['zh', '中文'],
    ['en', 'English'],
    ['ja', '日本語'],
    ['ko', '한국어'],
] as const;

export function VoiceSettings() {
    const { t } = useTranslation();
    const { credentials } = useAuth();
    const toast = useToast();

    const [voiceId, setVoiceId] = useSettingMutable('voiceTtsVoiceId');
    const [asrLanguage, setAsrLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [readTextReplies, setReadTextReplies] = useSettingMutable('voiceReadTextReplies');
    const [assistantMachineId, setAssistantMachineId] = useSettingMutable('assistantMachineId');
    const [skipPermissions, setSkipPermissions] = useSettingMutable('assistantSkipPermissions');
    const machines = useAllMachines({ includeOffline: true });

    // ── voices list (graceful 404/501 degrade, errors consumed locally) ──
    const [voicesState, setVoicesState] = useState<VoicesState>({ kind: 'loading' });
    const voicesSeq = useRef(0);
    const loadVoices = useCallback(() => {
        if (!credentials) return;
        const seq = ++voicesSeq.current;
        void fetchTtsVoices(credentials).then((res) => {
            if (seq !== voicesSeq.current) return;
            if (res.kind === 'ok') setVoicesState({ kind: 'ok', voices: res.voices });
            else setVoicesState({ kind: 'unavailable' });
        });
    }, [credentials]);
    useEffect(() => {
        loadVoices();
        return () => {
            // Invalidate any in-flight fetch on unmount / credentials change.
            voicesSeq.current++;
        };
    }, [loadVoices]);

    // ── preview playback (settings click = user gesture, plain Audio is fine) ──
    // Keyed by a caller-chosen id: the library list may contain the same
    // voiceId as the account list, and only one play button should spin.
    const previewRef = useRef<HTMLAudioElement | null>(null);
    const [previewingId, setPreviewingId] = useState<string | null>(null);
    const onPreview = (key: string, previewUrl: string | undefined) => {
        if (!previewUrl) return;
        previewRef.current?.pause();
        const audio = new Audio(previewUrl);
        previewRef.current = audio;
        setPreviewingId(key);
        audio.onended = () => setPreviewingId((cur) => (cur === key ? null : cur));
        void audio.play().catch(() => setPreviewingId(null));
    };
    useEffect(() => {
        return () => previewRef.current?.pause();
    }, []);

    const previewButton = (key: string, previewUrl: string | undefined) =>
        previewUrl ? (
            <button
                type="button"
                className="set-header__back"
                aria-label={t('settingsVoice.preview')}
                title={t('settingsVoice.preview')}
                onClick={(e) => {
                    e.stopPropagation();
                    onPreview(key, previewUrl);
                }}
            >
                {previewingId === key ? <Spinner size={14} /> : <Play size={14} />}
            </button>
        ) : undefined;

    // ── voice library (B-081): collapsed by default, fetch on expand ──
    const [library, setLibrary] = useState<LibraryState>({ kind: 'collapsed' });
    const [libraryLang, setLibraryLang] = useState<string>('zh');
    const librarySeq = useRef(0);

    const loadLibrary = useCallback((lang: string) => {
        if (!credentials) return;
        const seq = ++librarySeq.current;
        setLibrary({ kind: 'loading' });
        void fetchSharedVoices(credentials, lang).then((res) => {
            if (seq !== librarySeq.current) return;
            if (res.kind === 'ok') setLibrary({ kind: 'ok', voices: res.voices });
            else if (res.kind === 'unsupported') setLibrary({ kind: 'unavailable' });
            else setLibrary({ kind: 'error' });
        });
    }, [credentials]);

    const expandLibrary = () => {
        // Default language follows the recognition-language setting; fall
        // back to Chinese (the feature exists for Chinese voices first).
        const lang = LIBRARY_LANGS.some(([code]) => code === asrLanguage)
            ? (asrLanguage as string)
            : 'zh';
        setLibraryLang(lang);
        loadLibrary(lang);
    };

    const onLibraryLang = (lang: string) => {
        if (lang === libraryLang && library.kind !== 'error') return;
        setLibraryLang(lang);
        loadLibrary(lang);
    };

    // ── add shared voice to the account ──
    const [addingId, setAddingId] = useState<string | null>(null);
    const onAddVoice = async (voice: SharedVoice) => {
        if (!credentials || addingId !== null) return;
        setAddingId(voice.voiceId);
        const res = await addSharedVoice(credentials, {
            publicUserId: voice.publicUserId,
            voiceId: voice.voiceId,
            name: voice.name,
        });
        setAddingId(null);
        if (res.kind === 'ok') {
            toast.success(t('settingsVoice.libraryAdded', { name: voice.name }));
            // Clicking add means "use it": select the new voice and re-pull
            // the account list (the server invalidated its cache on add).
            setVoiceId(res.voiceId);
            loadVoices();
        } else if (res.kind === 'unsupported') {
            toast.error(t('settingsVoice.libraryUnavailable'));
        } else {
            toast.error(t('settingsVoice.libraryAddFailed'));
        }
    };

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
                                    left={previewButton(voice.voiceId, voice.previewUrl)}
                                    right={voiceId === voice.voiceId ? <Check size={16} /> : undefined}
                                    onClick={() => setVoiceId(voice.voiceId)}
                                />
                            ))}
                        </>
                    )}
                </ItemGroup>

                <ItemGroup
                    title={t('settingsVoice.library')}
                    footer={library.kind === 'collapsed' ? undefined : t('settingsVoice.libraryHint')}
                >
                    {library.kind === 'collapsed' && (
                        <Item title={t('settingsVoice.libraryBrowse')} onClick={expandLibrary} />
                    )}
                    {library.kind !== 'collapsed' && (
                        <Item
                            title={t('settingsVoice.libraryLanguage')}
                            right={
                                <span className="set-seg">
                                    {LIBRARY_LANGS.map(([code, label]) => (
                                        <button
                                            key={code}
                                            type="button"
                                            className={`set-seg__btn${libraryLang === code ? ' is-active' : ''}`}
                                            onClick={() => onLibraryLang(code)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </span>
                            }
                        />
                    )}
                    {library.kind === 'loading' && (
                        <Item title={t('common.loading')} left={<Spinner size={16} />} />
                    )}
                    {library.kind === 'unavailable' && (
                        <Item title={t('settingsVoice.libraryUnavailable')} />
                    )}
                    {library.kind === 'error' && (
                        <Item
                            title={t('settingsVoice.libraryLoadFailed')}
                            onClick={() => loadLibrary(libraryLang)}
                        />
                    )}
                    {library.kind === 'ok' && library.voices.length === 0 && (
                        <Item title={t('settingsVoice.libraryEmpty')} />
                    )}
                    {library.kind === 'ok' &&
                        library.voices.map((voice) => (
                            <Item
                                key={`lib-${voice.voiceId}`}
                                title={voice.name}
                                subtitle={
                                    voice.labels
                                        ? Object.values(voice.labels).join(' · ')
                                        : voice.description
                                }
                                left={previewButton(`lib-${voice.voiceId}`, voice.previewUrl)}
                                right={
                                    <button
                                        type="button"
                                        className="set-voice-add"
                                        disabled={addingId !== null}
                                        onClick={() => void onAddVoice(voice)}
                                    >
                                        {addingId === voice.voiceId ? (
                                            <Spinner size={12} />
                                        ) : (
                                            t('settingsVoice.libraryAdd')
                                        )}
                                    </button>
                                }
                            />
                        ))}
                </ItemGroup>

                <ItemGroup title={t('settingsVoice.asrLanguage')} footer={t('settingsVoice.asrLanguageHint')}>
                    <Item
                        title={t('settingsVoice.asrLanguageAuto')}
                        right={asrLanguage == null ? <Check size={16} /> : undefined}
                        onClick={() => setAsrLanguage(null)}
                    />
                    {([
                        ['zh', '中文'],
                        ['en', 'English'],
                        ['ja', '日本語'],
                    ] as const).map(([code, label]) => (
                        <Item
                            key={code}
                            title={label}
                            right={asrLanguage === code ? <Check size={16} /> : undefined}
                            onClick={() => setAsrLanguage(code)}
                        />
                    ))}
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
