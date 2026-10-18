/**
 * Profile (B-621) — display name and public handle. The handle is the name
 * colleagues type into People search and the share dialog; it is NOT the
 * login username (password accounts keep that unchanged).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { ProfileApiError, updateProfile } from '@/sync/apiAccount';
import { useProfile } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Button, Input, useToast } from '@/ui';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { handleIssue } from './profileHandle';

export function ProfileSettings() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const { credentials } = useAuth();
    const toast = useToast();
    const profile = useProfile();
    const [firstName, setFirstName] = useState(profile.firstName ?? '');
    const [lastName, setLastName] = useState(profile.lastName ?? '');
    const [username, setUsername] = useState(profile.username ?? '');
    const [busy, setBusy] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);

    // Re-seed when the profile arrives after the page (first load / socket update).
    useEffect(() => { setFirstName(profile.firstName ?? ''); setLastName(profile.lastName ?? ''); setUsername(profile.username ?? ''); }, [profile.firstName, profile.lastName, profile.username]);

    const issue = handleIssue(username);
    const handleError = issue === 'invalid' ? t('settingsProfile.handleInvalid') : null;
    const dirty = (profile.firstName ?? '') !== firstName.trim() || (profile.lastName ?? '') !== lastName.trim() || (profile.username ?? '') !== username.trim().toLowerCase();
    const canSubmit = dirty && issue !== 'invalid' && !busy && !!credentials;

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!canSubmit || !credentials) return;
        setBusy(true); setServerError(null);
        try {
            await updateProfile(credentials, {
                firstName: firstName.trim() || null,
                lastName: lastName.trim() || null,
                username: username.trim() ? username.trim().toLowerCase() : null,
            });
            await sync.refreshProfile();
            toast.success(t('common.success'));
            navigate('/settings/account');
        } catch (err) {
            if (err instanceof ProfileApiError && err.code === 'username_taken') setServerError(t('settingsProfile.handleTaken'));
            else if (err instanceof ProfileApiError && err.code === 'invalid_username') setServerError(t('settingsProfile.handleInvalid'));
            else if (err instanceof ProfileApiError && err.code === 'too_many_requests') setServerError(t('settingsProfile.tooMany'));
            else setServerError(t('common.error'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Page>
            <Header title={t('settingsProfile.title')} subtitle={t('settingsProfile.subtitle')} />
            <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                <Input label={t('profile.firstName')} autoComplete="given-name" value={firstName} maxLength={80} onChange={(e) => setFirstName(e.target.value)} />
                <Input label={t('profile.lastName')} autoComplete="family-name" value={lastName} maxLength={80} onChange={(e) => setLastName(e.target.value)} />
                <Input
                    label={t('settingsProfile.handle')}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    maxLength={64}
                    placeholder="alice"
                    onChange={(e) => setUsername(e.target.value.toLowerCase())}
                    error={handleError ?? serverError}
                />
                <div className="set-note">{t('settingsProfile.handleHint')}</div>
                <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>{t('common.save')}</Button>
            </form>
        </Page>
    );
}
