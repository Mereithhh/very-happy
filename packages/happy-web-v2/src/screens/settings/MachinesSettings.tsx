/**
 * Settings → Machines (B-082): the discoverable doorway to /machine/:id.
 *
 * The machine detail screen (rename via metadata.displayName, spawn, recent
 * paths) has existed since the fork but NO navigation ever pointed at it —
 * an island page. This list is the entry: every known machine, online state,
 * click through to the detail screen.
 *
 * Separate file on purpose: SettingsRoutes.tsx is a declared conflict
 * hot-zone — it only gains an import, one <Route> line and one overview
 * <Item> (the VoiceSettings precedent).
 */

import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, HardDrive, PlusCircle } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { ItemList, ItemGroup, Item, StatusDot } from '@/ui';
import { useAllMachines, useSupersededMachineIds } from '@/sync/storage';
import { machineLabel, isMachineOnline } from '@/utils/machineUtils';
import { useTranslation } from '@/i18n/useTranslation';

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

export function MachinesSettings() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    // B-361: this is the ONE screen that still lists superseded rows. Every
    // other surface drops them, but a leftover the user can neither see nor
    // remove is worse than a labelled one — the delete action lives behind
    // this row.
    const machines = useAllMachines({ includeOffline: true, includeSuperseded: true });
    const superseded = useSupersededMachineIds();

    return (
        <Page>
            <Header title={t('settingsMachines.title')} />
            <ItemList>
                {/* B-296: connecting another machine was only ever documented on
                    FirstRunScreen, which disappears for good after machine #1. */}
                <ItemGroup title={t('connectMachine.groupTitle')}>
                    <Item
                        title={t('connectMachine.cta')}
                        subtitle={t('connectMachine.settingsSubtitle')}
                        left={<PlusCircle size={18} />}
                        right={<ChevronRight size={16} />}
                        onClick={() => navigate('/machine/connect')}
                    />
                </ItemGroup>
                <ItemGroup title={t('settingsMachines.listTitle')} footer={t('settingsMachines.footer')}>
                    {machines.length === 0 && <Item title={t('settingsMachines.empty')} />}
                    {machines.map((m) => {
                        const online = isMachineOnline(m);
                        const isSuperseded = superseded.has(m.id);
                        const state = isSuperseded
                            ? t('settingsMachines.superseded')
                            : online ? t('settingsMachines.online') : t('settingsMachines.offline');
                        return (
                            <Item
                                key={m.id}
                                title={machineLabel(m)}
                                subtitle={`${m.metadata?.host ?? m.id.slice(0, 8)} · ${state}`}
                                left={<HardDrive size={18} />}
                                right={
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                        <StatusDot status={online ? 'connected' : 'offline'} />
                                        <ChevronRight size={16} />
                                    </span>
                                }
                                onClick={() => navigate(`/machine/${m.id}`)}
                            />
                        );
                    })}
                </ItemGroup>
            </ItemList>
        </Page>
    );
}
