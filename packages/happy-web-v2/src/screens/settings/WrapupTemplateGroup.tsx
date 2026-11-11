/**
 * B-915 settings → 快捷指令 → 收尾模板. The account's wrap-up template, stored
 * in the account KV (`vh.wrapup.v1`) so the CLI / MCP entry points send the
 * same text as the Web. Draft-then-save; empty = the built-in default (shown
 * as the placeholder). KV values are plain text on the server: the footer
 * says not to put secrets in it. A version conflict reloads the other device's text.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_WRAPUP_TEMPLATE, WRAPUP_TEMPLATE_MAX_CHARS } from '@slopus/happy-wire';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, ItemGroup, useToast } from '@/ui';
import { loadWrapupConfig, saveWrapupConfig, wrapupLangOf, type WrapupConfigState } from '@/app/sessionWrapup';

export function WrapupTemplateGroup() {
    const { t, lang } = useTranslation();
    const toast = useToast();
    const uiLang = wrapupLangOf(lang);
    const [state, setState] = useState<WrapupConfigState | null>(null);
    const [draft, setDraft] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let alive = true;
        void loadWrapupConfig().then((s) => { if (alive) setState(s); });
        return () => { alive = false; };
    }, []);
    const stored = state?.config.template ?? '';
    const value = draft ?? stored;
    const dirty = draft !== null && draft.trim() !== stored.trim();

    async function save(template: string | null) {
        if (!state || busy) return;
        setBusy(true);
        try {
            const result = await saveWrapupConfig({ template, lang: uiLang }, state.version);
            if (result.ok) {
                setState({ config: { template, lang: uiLang }, version: result.version });
                setDraft(null);
                toast.success(t('wrapup.settingsSaved'));
            } else if (result.conflict) {
                setState(result.conflict);
                setDraft(null);
                toast.error(t('wrapup.settingsConflict'));
            } else {
                toast.error(t('wrapup.settingsSaveFailed'));
            }
        } catch {
            toast.error(t('wrapup.settingsSaveFailed'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <ItemGroup settingId="snippets.wrapup" title={t('wrapup.settingsGroup')} footer={t('wrapup.settingsFooter')}>
            <div className="set-wrapup">
                <textarea
                    className="set-editor__textarea set-wrapup__textarea"
                    aria-label={t('wrapup.settingsGroup')}
                    value={value}
                    disabled={!state}
                    maxLength={WRAPUP_TEMPLATE_MAX_CHARS}
                    placeholder={state ? DEFAULT_WRAPUP_TEMPLATE[uiLang] : t('wrapup.settingsLoading')}
                    onChange={(e) => setDraft(e.target.value)}
                />
                <div className="set-editor__row">
                    <Button variant="ghost" disabled={!state || busy || (!stored && draft === null)} onClick={() => void save(null)}>
                        {t('wrapup.settingsReset')}
                    </Button>
                    <Button variant="primary" disabled={!state || busy || !dirty} aria-busy={busy || undefined} onClick={() => void save(value.trim() ? value : null)}>
                        {t('wrapup.settingsSave')}
                    </Button>
                </div>
            </div>
        </ItemGroup>
    );
}
