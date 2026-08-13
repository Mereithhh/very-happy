import { useNavigate } from 'react-router-dom';
import { TerminalSquare, Plus } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useAllMachines } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { isMachineOnline } from '@/utils/machineUtils';
import { ItemList, ItemGroup, Item, EmptyState, StatusDot } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';

function machineLabel(m: any): string {
  return m?.metadata?.displayName || m?.metadata?.host || m?.id?.slice(0, 8) || 'machine';
}

export function TerminalPickerScreen() {
  const navigate = useNavigate();
  const machines = useAllMachines({ includeOffline: true });
  const createTerminal = useTerminalSessions((s) => s.create);
  const terminals = useTerminalSessions((s) => s.terminals);
  const { t } = useTranslation();

  const openNew = (machineId: string, name: string) => {
    const term = createTerminal(machineId, name);
    // fresh=1: the ONE open allowed to create the tmux session (see
    // WebTerminalScreen) — every other open is attach-only.
    navigate(`/terminal/${machineId}?tid=${term.id}&fresh=1`);
  };

  return (
    <div className="picker">
      {/* header is just the back row now — shown on every width, like every
          other screen's back control (it hides itself at the root anyway) */}
      <header className="term-header">
        <BackButton />
      </header>
      <div style={{ padding: 'var(--sp-6)', overflowY: 'auto', flex: 1 }}>
        <h2 style={{ marginTop: 0 }}>{t('newSessionModal.terminalTitle')}</h2>
        {machines.length === 0 ? (
          <EmptyState
            compact
            title={t('machine.noMachines')}
            description={t('machine.noMachinesDescription')}
          />
        ) : (
          <ItemList>
            <ItemGroup title={t('newSessionModal.terminalSubtitle')}>
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
              <ItemGroup title={t('sidebar.openSessions')}>
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
