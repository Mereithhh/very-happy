import { useNavigate } from 'react-router-dom';
import { TerminalSquare, Plus, ChevronLeft } from 'lucide-react';
import { useAllMachines } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { isMachineOnline } from '@/utils/machineUtils';
import { ItemList, ItemGroup, Item, EmptyState, StatusDot, Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useIsDesktop } from '@/app/useMediaQuery';

function machineLabel(m: any): string {
  return m?.metadata?.displayName || m?.metadata?.host || m?.id?.slice(0, 8) || 'machine';
}

export function TerminalPickerScreen() {
  const navigate = useNavigate();
  const machines = useAllMachines({ includeOffline: true });
  const createTerminal = useTerminalSessions((s) => s.create);
  const terminals = useTerminalSessions((s) => s.terminals);
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();

  const openNew = (machineId: string, name: string) => {
    const term = createTerminal(machineId, name);
    navigate(`/terminal/${machineId}?tid=${term.id}`);
  };

  return (
    <div className="picker">
      {!isDesktop && (
        <header className="term-header">
          <button className="term-back" onClick={() => navigate('/')}>
            <ChevronLeft size={18} /> {t('common.back' as any)}
          </button>
        </header>
      )}
      <div style={{ padding: 'var(--sp-6)', overflowY: 'auto', flex: 1 }}>
        <h2 style={{ marginTop: 0 }}>{t('newSessionModal.terminalTitle' as any)}</h2>
        {machines.length === 0 ? (
          <EmptyState
            compact
            title={t('machine.noMachines' as any)}
            description={t('machine.noMachinesDescription' as any)}
          />
        ) : (
          <ItemList>
            <ItemGroup title={t('newSessionModal.terminalSubtitle' as any)}>
              {machines.map((m) => {
                const online = isMachineOnline(m);
                const name = machineLabel(m);
                return (
                  <Item
                    key={m.id}
                    title={name}
                    detail={m.metadata?.host}
                    left={<StatusDot status={online ? 'connected' : 'offline'} size={9} />}
                    right={online ? <Plus size={16} /> : undefined}
                    onClick={online ? () => openNew(m.id, name) : undefined}
                  />
                );
              })}
            </ItemGroup>

            {terminals.length > 0 && (
              <ItemGroup title={t('sidebar.openSessions' as any)}>
                {terminals.map((term) => (
                  <Item
                    key={term.id}
                    title={term.title}
                    detail={term.machineName}
                    left={<TerminalSquare size={16} />}
                    onClick={() => navigate(`/terminal/${term.machineId}?tid=${term.id}`)}
                  />
                ))}
              </ItemGroup>
            )}
          </ItemList>
        )}
      </div>
    </div>
  );
}
