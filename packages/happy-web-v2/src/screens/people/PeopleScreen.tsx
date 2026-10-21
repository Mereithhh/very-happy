/**
 * People (B-621) — the directory this server's accounts share: who I am
 * connected with, who is waiting for my answer, and a search box to find a
 * colleague by handle or email. Friends are what the share dialog offers
 * first (B-619), and what later Spaces will be built from.
 *
 * Every write goes straight to the server; the list re-reads from the
 * `relationship-updated` socket event AND an explicit refresh, so a row
 * never shows a state the server does not hold.
 */
import { Check, Search, UserPlus, UsersRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackButton } from '@/app/BackButton';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { removeFriend, searchUsersByUsername, sendFriendRequest } from '@/sync/apiFriends';
import { getDisplayName, type UserProfile } from '@/sync/friendTypes';
import { useFriends, useFriendsLoaded } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Button, EmptyState, Spinner, toast } from '@/ui';
import { groupPeople, initialsOf, personSubline, searchActionFor } from './peoplePresentation';
import './people.css';

type Busy = { id: string; verb: 'add' | 'remove' } | null;

export function PeopleScreen() {
    const { t } = useTranslation();
    const { credentials } = useAuth();
    const friendsMap = useFriends();
    const loaded = useFriendsLoaded();
    const all = useMemo(() => Object.values(friendsMap), [friendsMap]);
    const groups = useMemo(() => groupPeople(all), [all]);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<UserProfile[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [busy, setBusy] = useState<Busy>(null);
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const searchSeq = useRef(0);

    // Search as you type (300 ms), results carry the live relationship status.
    useEffect(() => {
        const q = query.trim();
        if (!credentials || q.length < 2) { setResults(null); setSearching(false); return; }
        const seq = ++searchSeq.current;
        setSearching(true);
        const handle = setTimeout(async () => {
            try {
                const users = await searchUsersByUsername(credentials, q);
                if (seq === searchSeq.current) setResults(users);
            } catch {
                if (seq === searchSeq.current) setResults([]);
            } finally {
                if (seq === searchSeq.current) setSearching(false);
            }
        }, 300);
        return () => clearTimeout(handle);
    }, [query, credentials]);

    // Overlay the directory state on search rows so a verb never lags the list.
    const rows = useMemo(() => results?.map((r) => friendsMap[r.id] ? { ...r, status: friendsMap[r.id].status } : r) ?? null, [results, friendsMap]);

    async function act(person: UserProfile, verb: 'add' | 'remove') {
        if (!credentials || busy) return;
        setBusy({ id: person.id, verb });
        setConfirmRemove(null);
        try {
            if (verb === 'add') await sendFriendRequest(credentials, person.id);
            else await removeFriend(credentials, person.id);
            await sync.refreshFriends();
            if (results) setResults((prev) => prev?.map((r) => r.id === person.id ? { ...r, status: verb === 'add' ? (r.status === 'pending' ? 'friend' : 'requested') : 'none' } : r) ?? null);
        } catch {
            toast.error(t('people.actionFailed'));
        } finally {
            setBusy(null);
        }
    }

    const Person = ({ person, actions }: { person: UserProfile; actions: React.ReactNode }) => {
        const name = getDisplayName(person);
        const sub = personSubline(person);
        return (
            <li className="pp-row">
                <span className="pp-avatar" aria-hidden>{person.avatar?.url ? <img src={person.avatar.url} alt="" /> : initialsOf(name)}</span>
                <span className="pp-text">
                    <span className="pp-name">{name}</span>
                    {sub && <span className="pp-sub">{sub}</span>}
                </span>
                <span className="pp-actions">{actions}</span>
            </li>
        );
    };

    const removeButton = (person: UserProfile, label: string) => confirmRemove === person.id ? (
        <>
            <span className="pp-confirm">{t('people.removeConfirm', { name: getDisplayName(person) })}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>{t('common.cancel')}</Button>
            <Button type="button" variant="danger" size="sm" loading={busy?.id === person.id} onClick={() => void act(person, 'remove')}>{label}</Button>
        </>
    ) : (
        <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(person.id)}>{label}</Button>
    );

    return (
        <div className="pp">
            <header className="pp-header">
                <BackButton />
                <h1 className="pp-title">{t('people.title')}</h1>
                <span className="pp-count mono">{loaded ? t('people.friendCount', { count: groups.friends.length }) : ''}</span>
            </header>

            <div className="pp-body">
                <section className="pp-section" aria-label={t('people.searchLabel')}>
                    <label className="pp-search">
                        <Search size={16} aria-hidden />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('people.searchPlaceholder')}
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            aria-label={t('people.searchLabel')}
                        />
                        {searching && <Spinner size={14} />}
                    </label>
                    <p className="pp-hint">{t('people.searchHint')}</p>
                    {rows && (
                        <ul className="pp-list" aria-label={t('people.results')}>
                            {rows.length === 0 && <li className="pp-empty">{t('people.noResults')}</li>}
                            {rows.map((person) => {
                                const action = searchActionFor(person.status);
                                return (
                                    <Person key={person.id} person={person} actions={
                                        action === 'add' ? <Button type="button" variant="primary" size="sm" loading={busy?.id === person.id} disabled={busy !== null} onClick={() => void act(person, 'add')}><UserPlus size={14} aria-hidden /> {t('people.add')}</Button>
                                        : action === 'accept' ? <Button type="button" variant="primary" size="sm" loading={busy?.id === person.id} disabled={busy !== null} onClick={() => void act(person, 'add')}><Check size={14} aria-hidden /> {t('people.accept')}</Button>
                                        : action === 'cancel' ? <Button type="button" variant="ghost" size="sm" loading={busy?.id === person.id} disabled={busy !== null} onClick={() => void act(person, 'remove')}>{t('people.cancelRequest')}</Button>
                                        : <span className="pp-tag">{t('people.alreadyFriends')}</span>
                                    } />
                                );
                            })}
                        </ul>
                    )}
                </section>

                {!loaded && <div className="pp-loading"><Spinner /></div>}

                {loaded && groups.incoming.length > 0 && (
                    <section className="pp-section">
                        <h2 className="pp-section-title">{t('people.incoming')} <span className="pp-badge mono">{groups.incoming.length}</span></h2>
                        <ul className="pp-list">
                            {groups.incoming.map((person) => (
                                <Person key={person.id} person={person} actions={<>
                                    <Button type="button" variant="primary" size="sm" loading={busy?.id === person.id && busy.verb === 'add'} disabled={busy !== null} onClick={() => void act(person, 'add')}><Check size={14} aria-hidden /> {t('people.accept')}</Button>
                                    <Button type="button" variant="ghost" size="sm" loading={busy?.id === person.id && busy.verb === 'remove'} disabled={busy !== null} onClick={() => void act(person, 'remove')} aria-label={t('people.decline')}><X size={14} aria-hidden /> {t('people.decline')}</Button>
                                </>} />
                            ))}
                        </ul>
                    </section>
                )}

                {loaded && (
                    <section className="pp-section">
                        <h2 className="pp-section-title">{t('people.friends')}</h2>
                        {groups.friends.length === 0 ? (
                            <EmptyState compact icon={<UsersRound size={28} aria-hidden />} title={t('people.friendsEmpty')} />
                        ) : (
                            <ul className="pp-list">
                                {groups.friends.map((person) => <Person key={person.id} person={person} actions={removeButton(person, t('people.remove'))} />)}
                            </ul>
                        )}
                    </section>
                )}

                {loaded && groups.outgoing.length > 0 && (
                    <section className="pp-section">
                        <h2 className="pp-section-title">{t('people.outgoing')}</h2>
                        <ul className="pp-list">
                            {groups.outgoing.map((person) => <Person key={person.id} person={person} actions={
                                <Button type="button" variant="ghost" size="sm" loading={busy?.id === person.id} disabled={busy !== null} onClick={() => void act(person, 'remove')}>{t('people.cancelRequest')}</Button>
                            } />)}
                        </ul>
                    </section>
                )}
            </div>
        </div>
    );
}
