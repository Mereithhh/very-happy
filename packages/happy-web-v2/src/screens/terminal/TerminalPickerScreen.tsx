import { EmptyState, Button } from '@/ui';
import { useNavigate } from 'react-router-dom';
// P4: machine picker → open web terminal. Placeholder.
export function TerminalPickerScreen() {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Web terminal"
      description="Machine picker + xterm terminal land in P4."
      actions={<Button onClick={() => navigate('/')}>Back</Button>}
    />
  );
}
