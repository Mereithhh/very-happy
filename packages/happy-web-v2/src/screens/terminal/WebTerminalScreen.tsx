import { useParams } from 'react-router-dom';
import { EmptyState } from '@/ui';
// P4: xterm.js terminal with IME-correct input. Placeholder.
export function WebTerminalScreen() {
  const { machineId } = useParams();
  return <EmptyState title="Terminal" description={`Machine ${machineId} — terminal lands in P4.`} />;
}
