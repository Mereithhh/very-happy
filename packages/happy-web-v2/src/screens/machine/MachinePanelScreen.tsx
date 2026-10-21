/**
 * B-510: `/machine/:machineId/panel/:panelId` — one machine web panel full
 * screen. The push click target of `request_human` / `very-happy attention`.
 */
import { useParams } from 'react-router-dom';
import { useMachine } from '@/sync/storage';
import { parseWebPanels } from '@/sync/webPanels';
import { MachinePanelFrame } from '../workspace/MachinePanelFrame';
import { SettingsHeader } from '../settings/SettingsLayout';
import { useTranslation } from '@/i18n/useTranslation';
import './machinePanel.css';

export function MachinePanelScreen() {
  const { machineId = '', panelId = '' } = useParams();
  const { t } = useTranslation();
  const machine = useMachine(machineId);
  const panel = parseWebPanels(machine?.daemonState).find((p) => p.id === panelId) ?? null;
  const machineName = machine?.metadata?.displayName || machine?.metadata?.host || machineId.slice(0, 8);
  return <div className="machine-panel-screen">
    <SettingsHeader title={panel?.title ?? t('webPanels.missingTitle')} subtitle={machineName} />
    <MachinePanelFrame panel={panel} />
  </div>;
}

export default MachinePanelScreen;
